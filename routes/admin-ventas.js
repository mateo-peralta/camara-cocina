// routes/admin-ventas.js
// Todo lo que haces tú directamente desde el panel privado — nunca
// expuesto en la página pública de venta, siempre protegido con tu
// clave de administrador:
//
//  - POST /admin/venta-manual        vende de inmediato (efectivo, en persona)
//  - POST /admin/reservar-manual     aparta números SIN venderlos aún
//  - POST /admin/ordenes/:id/modificar   cambia datos o números de una orden pendiente
//
// En los tres puedes mandar `numeros: [12, 45]` si quieres números
// específicos, o `cantidad: 3` y el sistema toma los disponibles más
// bajos automáticamente.

const express = require('express');
const { v4: uuidv4 } = require('uuid');
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

// Resuelve qué números usar: los que mandaste explícitos, o los N
// disponibles más bajos si solo mandaste una cantidad.
function elegirNumeros(rifa, { numeros, cantidad }) {
  if (Array.isArray(numeros) && numeros.length > 0) {
    if (!numeros.every((n) => Number.isInteger(n) && n > 0)) {
      return { ok: false, error: 'Los números deben ser enteros positivos' };
    }
    return { ok: true, numeros: [...new Set(numeros)] };
  }
  if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 100) {
    return { ok: false, error: 'Cantidad inválida' };
  }
  const disponibles = db
    .prepare(`SELECT numero FROM numeros WHERE rifa_id = ? AND estado = 'disponible' ORDER BY numero ASC LIMIT ?`)
    .all(rifa.id, cantidad)
    .map((r) => r.numero);
  if (disponibles.length < cantidad) {
    return { ok: false, error: `Solo quedan ${disponibles.length} números disponibles.` };
  }
  return { ok: true, numeros: disponibles };
}

const crearOrdenYReservarTx = db.transaction((rifa, numerosElegidos, datosComprador, metodoPago, minutos) => {
  const placeholders = numerosElegidos.map(() => '?').join(',');
  const filas = db
    .prepare(`SELECT numero, estado FROM numeros WHERE rifa_id = ? AND numero IN (${placeholders})`)
    .all(rifa.id, ...numerosElegidos);

  if (filas.length !== numerosElegidos.length) {
    return { ok: false, error: 'Uno o más números no existen en esta rifa.' };
  }
  const noDisponibles = filas.filter((f) => f.estado !== 'disponible').map((f) => f.numero);
  if (noDisponibles.length > 0) {
    return { ok: false, error: `Estos números ya no están disponibles: ${noDisponibles.join(', ')}` };
  }

  const id = uuidv4();
  const buyOrder = 'MAN' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1000);
  const monto = numerosElegidos.length * rifa.precio_boleto;

  db.prepare(`
    INSERT INTO ordenes (id, rifa_id, comprador_nombre, comprador_email, comprador_telefono, cantidad, monto, buy_order, metodo_pago)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, rifa.id, datosComprador.nombre || '', datosComprador.email || '', datosComprador.telefono || '', numerosElegidos.length, monto, buyOrder, metodoPago);

  const placeholders2 = numerosElegidos.map(() => '?').join(',');
  const vigencia = minutos
    ? db.prepare(`SELECT datetime('now', '+${minutos} minutes') AS h`).get().h
    : null;
  db.prepare(`
    UPDATE numeros SET estado = 'reservado', orden_id = ?, reservado_hasta = ?
    WHERE rifa_id = ? AND numero IN (${placeholders2})
  `).run(id, vigencia, rifa.id, ...numerosElegidos);

  return { ok: true, ordenId: id, monto };
});

// ---------- Venta manual: se marca pagada de inmediato ----------
router.post('/admin/venta-manual', requireAdmin, async (req, res) => {
  const { rifaId, nombre, email, telefono, cantidad, numeros, enviarCorreo } = req.body || {};

  if (!rifaId || !nombre || !email || !telefono || (!cantidad && !numeros)) {
    return res.status(400).json({ error: 'Faltan campos: rifaId, nombre, email, telefono, y cantidad o numeros' });
  }

  const rifa = db.prepare('SELECT * FROM rifas WHERE id = ?').get(rifaId);
  if (!rifa) return res.status(404).json({ error: 'Rifa no encontrada' });

  const elegidos = elegirNumeros(rifa, { numeros, cantidad });
  if (!elegidos.ok) return res.status(409).json(elegidos);

  const resultado = crearOrdenYReservarTx(rifa, elegidos.numeros, { nombre, email, telefono }, 'manual', null);
  if (!resultado.ok) return res.status(409).json(resultado);

  const orden = db.prepare('SELECT * FROM ordenes WHERE id = ?').get(resultado.ordenId);

  try {
    const numerosVendidos = await emitirBoletos(orden, { enviarCorreo: enviarCorreo !== false });
    res.status(201).json({ ordenId: orden.id, numeros: numerosVendidos, monto: orden.monto });
  } catch (err) {
    console.error('Error registrando venta manual:', err);
    res.status(500).json({ error: 'No se pudo registrar la venta' });
  }
});

// ---------- Reservar sin vender: aparta el número, no lo marca pagado ----------
router.post('/admin/reservar-manual', requireAdmin, (req, res) => {
  const { rifaId, nombre, email, telefono, cantidad, numeros, minutos } = req.body || {};

  if (!rifaId || (!cantidad && !numeros)) {
    return res.status(400).json({ error: 'Faltan campos: rifaId, y cantidad o numeros' });
  }

  const rifa = db.prepare('SELECT * FROM rifas WHERE id = ?').get(rifaId);
  if (!rifa) return res.status(404).json({ error: 'Rifa no encontrada' });

  const elegidos = elegirNumeros(rifa, { numeros, cantidad });
  if (!elegidos.ok) return res.status(409).json(elegidos);

  // Sin fecha límite si no se especifica — queda apartado hasta que tú lo
  // vendas, lo modifiques o lo canceles a mano.
  const resultado = crearOrdenYReservarTx(
    rifa, elegidos.numeros,
    { nombre: nombre || 'Reserva interna', email: email || '', telefono: telefono || '' },
    'reserva_manual',
    Number.isInteger(minutos) ? minutos : null
  );
  if (!resultado.ok) return res.status(409).json(resultado);

  res.status(201).json({ ordenId: resultado.ordenId, numeros: elegidos.numeros, monto: resultado.monto });
});

// ---------- Modificar una orden pendiente: datos del comprador y/o números ----------
router.post('/admin/ordenes/:id/modificar', requireAdmin, (req, res) => {
  const orden = db.prepare('SELECT * FROM ordenes WHERE id = ?').get(req.params.id);
  if (!orden) return res.status(404).json({ error: 'Orden no encontrada' });
  if (orden.estado !== 'pendiente') {
    return res.status(409).json({ error: `Solo se pueden modificar órdenes pendientes (esta está "${orden.estado}").` });
  }

  const { nombre, email, telefono, numeros, cantidad } = req.body || {};
  const rifa = db.prepare('SELECT * FROM rifas WHERE id = ?').get(orden.rifa_id);

  const modificarTx = db.transaction(() => {
    // Cambiar los números: libera los actuales y reserva los nuevos.
    if (Array.isArray(numeros) || Number.isInteger(cantidad)) {
      // Libera temporalmente los números actuales para que elegirNumeros()
      // los pueda contar como candidatos si vuelven a pedirse los mismos.
      db.prepare(`
        UPDATE numeros SET estado = 'disponible', orden_id = NULL, reservado_hasta = NULL WHERE orden_id = ?
      `).run(orden.id);

      const elegidos = elegirNumeros(rifa, { numeros, cantidad });
      if (!elegidos.ok) return elegidos;

      const placeholders = elegidos.numeros.map(() => '?').join(',');
      const filas = db
        .prepare(`SELECT numero, estado FROM numeros WHERE rifa_id = ? AND numero IN (${placeholders})`)
        .all(rifa.id, ...elegidos.numeros);
      const noDisponibles = filas.filter((f) => f.estado !== 'disponible').map((f) => f.numero);
      if (noDisponibles.length > 0) {
        return { ok: false, error: `Estos números ya no están disponibles: ${noDisponibles.join(', ')}` };
      }

      const monto = elegidos.numeros.length * rifa.precio_boleto;
      db.prepare(`UPDATE ordenes SET cantidad = ?, monto = ? WHERE id = ?`)
        .run(elegidos.numeros.length, monto, orden.id);

      const placeholders2 = elegidos.numeros.map(() => '?').join(',');
      db.prepare(`
        UPDATE numeros SET estado = 'reservado', orden_id = ? WHERE rifa_id = ? AND numero IN (${placeholders2})
      `).run(orden.id, rifa.id, ...elegidos.numeros);
    }

    // Actualizar datos del comprador, solo los campos que mandaste.
    const campos = [];
    const valores = [];
    if (nombre) { campos.push('comprador_nombre = ?'); valores.push(nombre); }
    if (email) { campos.push('comprador_email = ?'); valores.push(email); }
    if (telefono) { campos.push('comprador_telefono = ?'); valores.push(telefono); }
    if (campos.length > 0) {
      valores.push(orden.id);
      db.prepare(`UPDATE ordenes SET ${campos.join(', ')} WHERE id = ?`).run(...valores);
    }

    return { ok: true };
  });

  const resultado = modificarTx();
  if (!resultado.ok) return res.status(409).json(resultado);

  const ordenActualizada = db.prepare('SELECT * FROM ordenes WHERE id = ?').get(orden.id);
  const numerosActuales = db
    .prepare('SELECT numero FROM numeros WHERE orden_id = ? ORDER BY numero ASC')
    .all(orden.id).map((n) => n.numero);

  res.json({ ok: true, orden: ordenActualizada, numeros: numerosActuales });
});

module.exports = router;
