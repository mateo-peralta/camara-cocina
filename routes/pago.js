// routes/pago.js
// Flujo de pago con Mercado Pago Checkout Pro. Dos pasos:
//
//  1) POST /api/pago/iniciar   -> crea una "preferencia" y devuelve el
//                                  link de pago (init_point)
//  2) POST /api/pago/webhook   -> Mercado Pago notifica el resultado acá;
//                                  se confirma consultando la API con el
//                                  payment_id, NUNCA confiando ciegamente
//                                  en lo que llega en la notificación.
//
// Los boletos solo se emiten dentro del webhook, y solo si el pago
// aparece como "approved" al consultarlo directo con la API de Mercado Pago.

const express = require('express');
const crypto = require('crypto');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const db = require('../db');
const { emitirBoletos } = require('../ticketing');

const router = express.Router();

const client = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN || 'TEST-0000000000000000-000000-00000000000000000000000000000000-000000000'
});

function frontendResultUrl() {
  return process.env.FRONTEND_RESULT_URL || 'http://localhost:3000/resultado.html';
}

// ---------- 1) Iniciar pago ----------
router.post('/pago/iniciar', async (req, res) => {
  const { ordenId } = req.body || {};
  if (!ordenId) return res.status(400).json({ error: 'Falta ordenId' });

  const orden = db.prepare('SELECT * FROM ordenes WHERE id = ?').get(ordenId);
  if (!orden) return res.status(404).json({ error: 'Orden no encontrada' });
  if (orden.estado !== 'pendiente') {
    return res.status(409).json({ error: `La orden ya está en estado "${orden.estado}"` });
  }

  try {
    const preference = new Preference(client);
    const resultado = await preference.create({
      body: {
        items: [{
          title: `Perfume Fácil — ${orden.cantidad} número${orden.cantidad > 1 ? 's' : ''}`,
          quantity: 1,
          unit_price: orden.monto,
          currency_id: 'CLP'
        }],
        payer: { name: orden.comprador_nombre, email: orden.comprador_email },
        external_reference: orden.id,
        back_urls: {
          success: frontendResultUrl(),
          pending: frontendResultUrl(),
          failure: frontendResultUrl()
        },
        auto_return: 'approved',
        notification_url: process.env.MP_WEBHOOK_URL || undefined
      }
    });

    db.prepare('UPDATE ordenes SET mp_preference_id = ? WHERE id = ?')
      .run(resultado.id, orden.id);

    // init_point = link de pago real; sandbox_init_point sirve para pruebas
    // con credenciales de prueba (TEST-...).
    const url = process.env.MP_ENV === 'production' ? resultado.init_point : (resultado.sandbox_init_point || resultado.init_point);
    res.json({ url });
  } catch (err) {
    console.error('Error creando preferencia en Mercado Pago:', err);
    res.status(502).json({ error: 'No se pudo iniciar el pago con Mercado Pago' });
  }
});

// ---------- 2) Webhook: acá se confirma el pago de verdad ----------
router.post('/pago/webhook', async (req, res) => {
  // Responder rápido: Mercado Pago solo necesita un 200, y reintenta si no lo recibe.
  res.sendStatus(200);

  try {
    if (!verificarFirmaWebhook(req)) {
      console.warn('Webhook de Mercado Pago con firma inválida — ignorado.');
      return;
    }

    const paymentId = req.body?.data?.id || req.query['data.id'];
    const tipo = req.body?.type || req.query.type;
    if (tipo !== 'payment' || !paymentId) return;

    // Nunca confiar en el estado que viene en la notificación: se
    // consulta el pago directo contra la API de Mercado Pago.
    const paymentApi = new Payment(client);
    const pago = await paymentApi.get({ id: paymentId });

    const ordenId = pago.external_reference;
    const orden = db.prepare('SELECT * FROM ordenes WHERE id = ?').get(ordenId);
    if (!orden) return;
    if (orden.estado !== 'pendiente') return; // ya procesada, evita duplicados

    const montoCoincide = Math.round(pago.transaction_amount) === orden.monto;

    if (pago.status === 'approved' && montoCoincide) {
      await emitirBoletos(orden);
    } else if (['rejected', 'cancelled'].includes(pago.status)) {
      db.prepare('UPDATE ordenes SET estado = ? WHERE id = ?').run('rechazado', orden.id);
    }
    // Si queda "pending" o "in_process" (ej. pago en efectivo), se deja la
    // orden como está: Mercado Pago volverá a notificar cuando cambie.
  } catch (err) {
    console.error('Error procesando webhook de Mercado Pago:', err);
  }
});

// Mercado Pago firma cada notificación con un header x-signature (HMAC-SHA256).
// Verificarlo evita que cualquiera pueda mandar una notificación falsa de
// "pago aprobado" sin haber pagado nada.
function verificarFirmaWebhook(req) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('MP_WEBHOOK_SECRET no configurado — no se puede verificar el webhook. Configúralo antes de producción.');
    return process.env.MP_ENV !== 'production'; // solo permite pasar en pruebas
  }

  const signatureHeader = req.header('x-signature');
  const requestId = req.header('x-request-id');
  if (!signatureHeader) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(',').map((p) => p.trim().split('=').map((s) => s.trim()))
  );
  const { ts, v1 } = parts;
  if (!ts || !v1) return false;

  const dataId = req.body?.data?.id || req.query['data.id'] || '';
  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;

  const hash = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  return hash === v1;
}

module.exports = router;
