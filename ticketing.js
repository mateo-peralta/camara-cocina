// ticketing.js
// Confirma como "vendidos" los números que el comprador ya había elegido y
// reservado (ver /rifas/:id/reservar en routes/ordenes.js). Ya no se numera
// nada acá — el número lo eligió el cliente en la cartilla, esto solo
// confirma esa reserva. Lo usan tres caminos (Mercado Pago, transferencia
// confirmada a mano, venta manual), todos dentro de una transacción para
// que dos confirmaciones simultáneas nunca se pisen.

const db = require('./db');
const { notificarVentaConfirmada } = require('./email');

const confirmarVentaTx = db.transaction((orden) => {
  const numeros = db
    .prepare(`SELECT numero FROM numeros WHERE orden_id = ? ORDER BY numero ASC`)
    .all(orden.id)
    .map((r) => r.numero);

  if (numeros.length === 0) {
    throw new Error(`La orden ${orden.id} no tiene números reservados asociados`);
  }

  db.prepare(`UPDATE numeros SET estado = 'vendido', reservado_hasta = NULL WHERE orden_id = ?`)
    .run(orden.id);

  db.prepare(`UPDATE ordenes SET estado = 'pagado', confirmado_en = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(orden.id);

  return numeros;
});

// Confirma la venta y, salvo que se indique lo contrario, envía los
// correos de confirmación (al comprador y a la copia administrativa).
async function emitirBoletos(orden, { enviarCorreo = true } = {}) {
  const numeros = confirmarVentaTx(orden);
  if (enviarCorreo) {
    try {
      await notificarVentaConfirmada(orden, numeros);
    } catch (err) {
      // Un correo fallido no debe deshacer una venta ya confirmada.
      console.error('Venta confirmada pero falló el envío de correo:', err);
    }
  }
  return numeros;
}

module.exports = { emitirBoletos };
