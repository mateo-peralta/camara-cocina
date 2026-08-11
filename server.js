// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const ordenesRouter = require('./routes/ordenes');
const pagoRouter = require('./routes/pago');
const sorteoRouter = require('./routes/sorteo');
const exportarRouter = require('./routes/exportar');
const transferenciaRouter = require('./routes/transferencia');
const adminVentasRouter = require('./routes/admin-ventas');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Mercado Pago puede notificar como form POST
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', ordenesRouter);
app.use('/api', pagoRouter);
app.use('/api', sorteoRouter);
app.use('/api', exportarRouter);
app.use('/api', transferenciaRouter);
app.use('/api', adminVentasRouter);

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor de la rifa escuchando en http://localhost:${PORT}`);
});
