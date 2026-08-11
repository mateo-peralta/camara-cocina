// routes/sorteo.js
// El sorteo es una acción de servidor, protegida con una clave de admin —
// nunca se decide en el navegador, para que nadie pueda manipular al ganador.
//
// Reparto fijo de esta rifa (4 ganadores distintos):
//   Premio 1 -> botella completa
//   Premio 2 -> decant 10 ml
//   Premio 3 -> 2 decants de 5 ml
//   Premio 4 -> 2 decants de 3 ml
// "Distintos" se interpreta como 4 personas distintas: una vez que alguien
// gana un premio, sus demás boletos quedan fuera del sorteo de los premios
// restantes.

const express = require('express');
const crypto = require('crypto');
const db = require('../db');

const router = express.Router();

function requireAdmin(req, res, next) {
  const key = req.header('x-admin-key');
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
}

router.get('/rifas/:rifaId/sorteo', (req, res) => {
  const rifa = db.prepare('SELECT * FROM rifas WHERE id = ?').get(req.params.rifaId);
  if (!rifa) return res.status(404).json({ error: 'Rifa no encontrada' });

  const ganadores = db.prepare(`
    SELECT g.ticket_numero, g.comprador_nombre, p.nombre AS premio, p.orden
    FROM ganadores g
    JOIN premios p ON p.id = g.premio_id
    WHERE g.rifa_id = ?
    ORDER BY p.orden ASC
  `).all(rifa.id);

  res.json({
    sorteado: !!rifa.sorteado_en,
    sorteadoEn: rifa.sorteado_en,
    fechaCierre: rifa.fecha_cierre,
    ganadores
  });
});

router.post('/rifas/:rifaId/sorteo/ejecutar', requireAdmin, (req, res) => {
  const rifa = db.prepare('SELECT * FROM rifas WHERE id = ?').get(req.params.rifaId);
  if (!rifa) return res.status(404).json({ error: 'Rifa no encontrada' });
  if (rifa.sorteado_en) {
    return res.status(409).json({ error: 'Esta rifa ya fue sorteada' });
  }

  const premios = db.prepare('SELECT * FROM premios WHERE rifa_id = ? ORDER BY orden ASC').all(rifa.id);

  // Números vendidos, con su comprador — la única fuente elegible para ganar.
  const boletos = db.prepare(`
    SELECT n.numero, o.comprador_nombre, o.comprador_email
    FROM numeros n
    JOIN ordenes o ON o.id = n.orden_id
    WHERE n.rifa_id = ? AND n.estado = 'vendido'
  `).all(rifa.id);

  // Compradores únicos con al menos un boleto pagado.
  const compradoresUnicos = new Set(boletos.map((b) => b.comprador_email));
  if (compradoresUnicos.size < premios.length) {
    return res.status(409).json({
      error: `Se necesitan al menos ${premios.length} compradores distintos con boleto pagado; hay ${compradoresUnicos.size}.`
    });
  }

  const ejecutar = db.transaction(() => {
    let pool = [...boletos];
    const resultado = [];

    for (const premio of premios) {
      // crypto.randomInt es un generador aleatorio criptográficamente seguro
      // (el mismo tipo que se usa para tokens de seguridad) — a diferencia
      // de Math.random(), no es predecible ni manipulable.
      const idx = crypto.randomInt(0, pool.length);
      const ganador = pool[idx];

      db.prepare(`
        INSERT INTO ganadores (rifa_id, premio_id, ticket_numero, comprador_nombre, comprador_email)
        VALUES (?, ?, ?, ?, ?)
      `).run(rifa.id, premio.id, ganador.numero, ganador.comprador_nombre, ganador.comprador_email);

      resultado.push({ premio: premio.nombre, orden: premio.orden, ticket: ganador.numero, nombre: ganador.comprador_nombre });

      // Saca del pool todos los boletos de este comprador para garantizar 4 ganadores distintos.
      pool = pool.filter((b) => b.comprador_email !== ganador.comprador_email);
    }

    db.prepare('UPDATE rifas SET sorteado_en = CURRENT_TIMESTAMP WHERE id = ?').run(rifa.id);
    return resultado;
  });

  try {
    const ganadores = ejecutar();
    res.json({ ok: true, ganadores });
  } catch (err) {
    console.error('Error ejecutando el sorteo:', err);
    res.status(500).json({ error: 'No se pudo ejecutar el sorteo' });
  }
});

module.exports = router;
