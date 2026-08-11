// routes/transferencia.js
// Camino alternativo a Mercado Pago: el comprador transfiere directo a tu
// cuenta y te manda el comprobante (por WhatsApp, como ya haces con la
// tienda). El número NO se marca como vendido solo — hasta que tú confirmes
// manualmente desde el panel de administración, sigue "pendiente".

const express = require('express');
const db = require('../db');
const { emitirBoletos } = require('../ticketing');

const router = express.Router();

function requireAdmin(req, res, next) {
  const key = req.header('x-admin-key');
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
}

// El comprador elige "pagar por transferencia": le devolvemos tus datos
// bancarios y dejamos su orden marcada con ese método.
router.post('/ordenes/:id/transferencia', (req, res) => {
  const orden = db.prepare('SELECT * FROM ordenes WHERE id = ?').get(req.params.id);
  if (!orden) return res.status(404).json({ error: 'Orden no encontrada' });
  if (orden.estado !== 'pendiente') {
    return res.status(409).json({ error: `La orden ya está en estado "${orden.estado}"` });
  }

  const extender = db.transaction(() => {
    db.prepare('UPDATE ordenes SET metodo_pago = ? WHERE id = ?').run('transferencia', orden.id);
    // Confirmar a mano toma más que los 12 minutos de una tarjeta —
    // se le da más margen para que el número no se libere solo mientras
    // esperas el comprobante.
    db.prepare(`
      UPDATE numeros SET reservado_hasta = datetime('now', '+2 hours')
      WHERE orden_id = ?
    `).run(orden.id);
  });
  extender();

  res.json({
    ordenId: orden.id,
    monto: orden.monto,
    datosBancarios: {
      nombre: 'Perfumes K&M',
      banco: process.env.BANK_NAME || '',
      tipoCuenta: process.env.BANK_ACCOUNT_TYPE || '',
      numeroCuenta: process.env.BANK_ACCOUNT_NUMBER || '',
      rut: process.env.BANK_RUT || '',
      email: process.env.BANK_EMAIL || ''
    },
    instrucciones: 'Envía el comprobante de la transferencia por WhatsApp para que confirmemos tu compra. Tus números quedan reservados mientras revisamos el pago.'
  });
});

// Tú confirmas desde el panel privado, después de ver el comprobante.
router.post('/admin/ordenes/:id/confirmar-transferencia', requireAdmin, async (req, res) => {
  const orden = db.prepare('SELECT * FROM ordenes WHERE id = ?').get(req.params.id);
  if (!orden) return res.status(404).json({ error: 'Orden no encontrada' });
  if (orden.metodo_pago !== 'transferencia') {
    return res.status(409).json({ error: 'Esta orden no fue creada como pago por transferencia' });
  }
  if (orden.estado !== 'pendiente') {
    return res.status(409).json({ error: `La orden ya está en estado "${orden.estado}"` });
  }

  try {
    const numeros = await emitirBoletos(orden);
    res.json({ ok: true, numeros });
  } catch (err) {
    console.error('Error confirmando transferencia:', err);
    res.status(500).json({ error: 'No se pudo confirmar la transferencia' });
  }
});

// Por si la transferencia nunca llega — la rechazas para liberar el cupo.
router.post('/admin/ordenes/:id/rechazar', requireAdmin, (req, res) => {
  const orden = db.prepare('SELECT * FROM ordenes WHERE id = ?').get(req.params.id);
  if (!orden) return res.status(404).json({ error: 'Orden no encontrada' });
  if (orden.estado !== 'pendiente') {
    return res.status(409).json({ error: `La orden ya está en estado "${orden.estado}"` });
  }
  const liberar = db.transaction(() => {
    db.prepare('UPDATE ordenes SET estado = ? WHERE id = ?').run('rechazado', orden.id);
    db.prepare(`
      UPDATE numeros SET estado = 'disponible', orden_id = NULL, reservado_hasta = NULL
      WHERE orden_id = ?
    `).run(orden.id);
  });
  liberar();
  res.json({ ok: true });
});

module.exports = router;
