// routes/ordenes.js
// Acá vive la cartilla real (150 números con su estado) y la reserva:
// el cliente elige números específicos en el navegador, y quedan
// "reservado" por 12 minutos mientras completa el pago. Si el pago no se
// confirma a tiempo, el número vuelve solo a "disponible" — no hay cron
// corriendo aparte, se liberan solos cada vez que se consulta la cartilla
// o se intenta una nueva reserva (ver liberarReservasVencidas).

const express = require('express');
const dns = require('dns').promises;
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

const RESERVA_MINUTOS = 12;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[+\d][\d\s()-]{7,}$/;

// Valida formato y, además, que el dominio tenga registros de correo (MX)
// configurados — así se descartan dominios inventados o mal escritos sin
// depender de ningún servicio externo de pago.
async function emailEsValido(email) {
  if (!EMAIL_RE.test(email)) return false;
  const dominio = email.split('@')[1];
  try {
    const mx = await dns.resolveMx(dominio);
    return mx && mx.length > 0;
  } catch {
    return false; // dominio inexistente o sin registros de correo
  }
}

// Cualquier número "reservado" cuyo plazo ya venció vuelve a "disponible".
// Se llama antes de leer o de reservar, así nunca hace falta un cron aparte.
function liberarReservasVencidas(rifaId) {
  db.prepare(`
    UPDATE numeros SET estado = 'disponible', orden_id = NULL, reservado_hasta = NULL
    WHERE rifa_id = ? AND estado = 'reservado' AND reservado_hasta < datetime('now')
  `).run(rifaId);
}

router.get('/rifas/:rifaId/estado', (req, res) => {
  const rifa = db.prepare('SELECT * FROM rifas WHERE id = ?').get(req.params.rifaId);
  if (!rifa) return res.status(404).json({ error: 'Rifa no encontrada' });

  liberarReservasVencidas(rifa.id);

  const vendidos = db
    .prepare(`SELECT COUNT(*) AS n FROM numeros WHERE rifa_id = ? AND estado = 'vendido'`)
    .get(rifa.id).n;

  res.json({
    rifaId: rifa.id,
    nombre: rifa.nombre,
    precioBoleto: rifa.precio_boleto,
    totalBoletos: rifa.total_boletos,
    fechaCierre: rifa.fecha_cierre,
    sorteado: !!rifa.sorteado_en,
    vendidos,
    disponibles: rifa.total_boletos - vendidos
  });
});

// La cartilla completa: los 150 números con su estado actual. El frontend
// pinta esto directo — nada de estados de ejemplo hardcodeados.
router.get('/rifas/:rifaId/cartilla', (req, res) => {
  const rifa = db.prepare('SELECT * FROM rifas WHERE id = ?').get(req.params.rifaId);
  if (!rifa) return res.status(404).json({ error: 'Rifa no encontrada' });

  liberarReservasVencidas(rifa.id);

  const numeros = db
    .prepare('SELECT numero, estado FROM numeros WHERE rifa_id = ? ORDER BY numero ASC')
    .all(rifa.id);

  res.json({ rifaId: rifa.id, numeros, reservaMinutos: RESERVA_MINUTOS });
});

// El cliente elige sus números en la cartilla y los reserva acá antes de
// pagar. Si alguno ya no está disponible (otro comprador se adelantó),
// la reserva completa se rechaza para que el cliente vuelva a elegir —
// nunca se le asignan números distintos a los que tocó en pantalla.
const reservarTx = db.transaction((rifa, numerosSolicitados, datosComprador) => {
  const placeholders = numerosSolicitados.map(() => '?').join(',');
  const filas = db
    .prepare(`SELECT numero, estado FROM numeros WHERE rifa_id = ? AND numero IN (${placeholders})`)
    .all(rifa.id, ...numerosSolicitados);

  if (filas.length !== numerosSolicitados.length) {
    return { ok: false, error: 'Uno o más números no existen en esta rifa.' };
  }
  const noDisponibles = filas.filter((f) => f.estado !== 'disponible').map((f) => f.numero);
  if (noDisponibles.length > 0) {
    return { ok: false, error: `Estos números ya no están disponibles: ${noDisponibles.join(', ')}`, noDisponibles };
  }

  const id = uuidv4();
  const buyOrder = 'RF' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1000);
  const monto = numerosSolicitados.length * rifa.precio_boleto;

  db.prepare(`
    INSERT INTO ordenes (id, rifa_id, comprador_nombre, comprador_email, comprador_telefono, cantidad, monto, buy_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, rifa.id, datosComprador.nombre, datosComprador.email, datosComprador.telefono, numerosSolicitados.length, monto, buyOrder);

  const placeholders2 = numerosSolicitados.map(() => '?').join(',');
  db.prepare(`
    UPDATE numeros
    SET estado = 'reservado', orden_id = ?, reservado_hasta = datetime('now', '+${RESERVA_MINUTOS} minutes')
    WHERE rifa_id = ? AND numero IN (${placeholders2})
  `).run(id, rifa.id, ...numerosSolicitados);

  return { ok: true, ordenId: id, monto, numeros: numerosSolicitados };
});

router.post('/rifas/:rifaId/reservar', async (req, res) => {
  const { nombre, email, telefono, numeros } = req.body || {};

  if (!nombre || !email || !telefono || !Array.isArray(numeros) || numeros.length === 0) {
    return res.status(400).json({ error: 'Faltan campos: nombre, email, telefono, numeros (arreglo no vacío)' });
  }
  if (numeros.length > 10) {
    return res.status(400).json({ error: 'Máximo 10 números por orden' });
  }
  if (!numeros.every((n) => Number.isInteger(n) && n > 0)) {
    return res.status(400).json({ error: 'Los números deben ser enteros positivos' });
  }
  if (!PHONE_RE.test(telefono)) {
    return res.status(400).json({ error: 'El teléfono ingresado no parece válido (ej: +56 9 1234 5678).' });
  }
  if (!(await emailEsValido(email))) {
    return res.status(400).json({ error: 'El correo ingresado no parece ser válido — revisa que esté bien escrito.' });
  }

  const rifa = db.prepare('SELECT * FROM rifas WHERE id = ?').get(req.params.rifaId);
  if (!rifa) return res.status(404).json({ error: 'Rifa no encontrada' });

  liberarReservasVencidas(rifa.id);

  const numerosUnicos = [...new Set(numeros)];
  const resultado = reservarTx(rifa, numerosUnicos, { nombre, email, telefono });

  if (!resultado.ok) {
    return res.status(409).json(resultado);
  }

  res.status(201).json({
    ordenId: resultado.ordenId,
    monto: resultado.monto,
    numeros: resultado.numeros,
    reservaMinutos: RESERVA_MINUTOS,
    estado: 'pendiente'
  });
});

router.get('/ordenes/:id', (req, res) => {
  const orden = db.prepare('SELECT * FROM ordenes WHERE id = ?').get(req.params.id);
  if (!orden) return res.status(404).json({ error: 'Orden no encontrada' });

  const numeros = db
    .prepare('SELECT numero, estado FROM numeros WHERE orden_id = ? ORDER BY numero ASC')
    .all(orden.id)
    .map((n) => n.numero);

  res.json({ ...orden, numeros });
});

module.exports = router;
