// routes/exportar.js
// Descarga en CSV (Excel lo abre directo) todo lo que necesitas para
// revisar los datos: compradores con sus números, y ganadores del sorteo.
// Protegido con la misma clave de administrador que el sorteo — nunca
// accesible desde la página pública de venta.

const express = require('express');
const db = require('../db');

const router = express.Router();

function requireAdmin(req, res, next) {
  const key = req.header('x-admin-key');
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
}

// Arma una línea CSV a prueba de comas y comillas dentro de los datos.
function filaCSV(valores) {
  return valores
    .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`)
    .join(',') + '\r\n';
}

router.get('/rifas/:rifaId/exportar/compradores', requireAdmin, (req, res) => {
  const filas = db.prepare(`
    SELECT o.comprador_nombre, o.comprador_email, o.comprador_telefono,
           o.cantidad, o.monto, o.estado, o.metodo_pago, o.creado_en, o.confirmado_en,
           n.numero, n.estado AS estado_numero
    FROM ordenes o
    LEFT JOIN numeros n ON n.orden_id = o.id
    WHERE o.rifa_id = ?
    ORDER BY o.creado_en ASC
  `).all(req.params.rifaId);

  let csv = filaCSV(['Nombre', 'Correo', 'Teléfono', 'Número', 'Estado número', 'Método de pago', 'Estado orden', 'Monto orden', 'Creado', 'Confirmado']);
  for (const f of filas) {
    csv += filaCSV([
      f.comprador_nombre, f.comprador_email, f.comprador_telefono,
      f.numero ?? '(sin asignar)', f.estado_numero || '—', f.metodo_pago, f.estado, f.monto, f.creado_en, f.confirmado_en
    ]);
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="compradores-${req.params.rifaId}.csv"`);
  res.send('\uFEFF' + csv); // BOM para que Excel reconozca tildes y ñ correctamente
});

router.get('/rifas/:rifaId/exportar/ganadores', requireAdmin, (req, res) => {
  const filas = db.prepare(`
    SELECT p.orden AS premio_orden, p.nombre AS premio, g.ticket_numero,
           g.comprador_nombre, g.comprador_email, g.sorteado_en
    FROM ganadores g
    JOIN premios p ON p.id = g.premio_id
    WHERE g.rifa_id = ?
    ORDER BY p.orden ASC
  `).all(req.params.rifaId);

  let csv = filaCSV(['Premio', 'Número ganador', 'Nombre', 'Correo', 'Sorteado en']);
  for (const f of filas) {
    csv += filaCSV([f.premio, f.ticket_numero, f.comprador_nombre, f.comprador_email, f.sorteado_en]);
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="ganadores-${req.params.rifaId}.csv"`);
  res.send('\uFEFF' + csv);
});

module.exports = router;
