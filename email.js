// email.js
// Envía dos correos cada vez que un pago se confirma:
//   1) al comprador, con sus números
//   2) a perfumeskm@outlook.com, avisando de la venta
//
// Usa Resend (https://resend.com). Requiere RESEND_API_KEY en el .env
// y un remitente verificado en tu cuenta de Resend (ej. rifa@tudominio.com).

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'Perfume Fácil <rifa@tudominio.com>';
const ADMIN_EMAIL = process.env.ADMIN_NOTIFICATION_EMAIL || 'perfumeskm@outlook.com';

async function enviarCorreo({ to, subject, html }) {
  if (!RESEND_API_KEY) {
    console.warn('RESEND_API_KEY no configurada — correo NO enviado:', subject, '->', to);
    return;
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from: FROM_EMAIL, to, subject, html })
    });
    if (!res.ok) {
      const body = await res.text();
      console.error('Error enviando correo:', res.status, body);
    }
  } catch (err) {
    console.error('Error de red enviando correo:', err);
  }
}

// Se llama justo después de marcar la orden como "pagado" y numerar los boletos.
async function notificarVentaConfirmada(orden, numeros) {
  const listaNumeros = numeros.map((n) => `<li>Número ${n}</li>`).join('');

  await enviarCorreo({
    to: orden.comprador_email,
    subject: `Perfume Fácil — confirmamos tu compra (${numeros.length} número${numeros.length > 1 ? 's' : ''})`,
    html: `
      <p>Hola ${orden.comprador_nombre},</p>
      <p>Tu pago fue confirmado. Estos son tus números para la rifa <strong>Perfume Fácil — Primera Edición</strong>:</p>
      <ul>${listaNumeros}</ul>
      <p>El sorteo se realiza al cierre de la rifa, entre todos los números pagados. Si resultas ganador/a, te contactaremos por WhatsApp para coordinar la entrega.</p>
      <p>Gracias por participar — Perfumes K&M</p>
    `
  });

  // Copia al correo administrativo, para llevar registro de cada venta sin
  // necesitar entrar al panel.
  await enviarCorreo({
    to: ADMIN_EMAIL,
    subject: `Nueva venta — orden ${orden.id} (${numeros.length} número${numeros.length > 1 ? 's' : ''})`,
    html: `
      <p>Se confirmó un pago en Perfume Fácil.</p>
      <ul>
        <li><strong>Comprador:</strong> ${orden.comprador_nombre} (${orden.comprador_email})</li>
        <li><strong>Teléfono:</strong> ${orden.comprador_telefono || '—'}</li>
        <li><strong>Números:</strong> ${numeros.join(', ')}</li>
        <li><strong>Monto:</strong> $${orden.monto.toLocaleString('es-CL')}</li>
        <li><strong>Orden:</strong> ${orden.id}</li>
      </ul>
    `
  });
}

module.exports = { notificarVentaConfirmada };
