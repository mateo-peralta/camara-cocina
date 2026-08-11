// db.js
// Base de datos SQLite embebida. Para producción con más de un servidor
// concurrente, migra esto a Postgres/MySQL — la lógica de transacciones
// (ver routes/pago.js) es la misma, solo cambia el driver.

const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'rifa.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS rifas (
  id            TEXT PRIMARY KEY,
  nombre        TEXT NOT NULL,
  precio_boleto INTEGER NOT NULL,
  total_boletos INTEGER NOT NULL,
  fecha_cierre  TEXT NOT NULL,
  sorteado_en   TEXT,
  creado_en     TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS premios (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  rifa_id  TEXT NOT NULL,
  orden    INTEGER NOT NULL,
  nombre   TEXT NOT NULL,
  FOREIGN KEY (rifa_id) REFERENCES rifas(id)
);

CREATE TABLE IF NOT EXISTS ganadores (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  rifa_id           TEXT NOT NULL,
  premio_id         INTEGER NOT NULL,
  ticket_numero     TEXT NOT NULL,
  comprador_nombre  TEXT NOT NULL,
  comprador_email   TEXT NOT NULL,
  sorteado_en       TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (rifa_id) REFERENCES rifas(id),
  FOREIGN KEY (premio_id) REFERENCES premios(id)
);

CREATE TABLE IF NOT EXISTS ordenes (
  id                TEXT PRIMARY KEY,
  rifa_id           TEXT NOT NULL,
  comprador_nombre  TEXT NOT NULL,
  comprador_email   TEXT NOT NULL,
  comprador_telefono TEXT NOT NULL,
  cantidad          INTEGER NOT NULL,
  monto             INTEGER NOT NULL,
  estado            TEXT NOT NULL DEFAULT 'pendiente', -- pendiente | pagado | rechazado | expirado
  metodo_pago       TEXT NOT NULL DEFAULT 'mercadopago', -- mercadopago | transferencia | manual
  buy_order         TEXT UNIQUE NOT NULL,
  session_id        TEXT,
  token_ws          TEXT,
  mp_preference_id  TEXT,
  creado_en         TEXT DEFAULT CURRENT_TIMESTAMP,
  confirmado_en     TEXT,
  FOREIGN KEY (rifa_id) REFERENCES rifas(id)
);

CREATE TABLE IF NOT EXISTS numeros (
  rifa_id         TEXT NOT NULL,
  numero          INTEGER NOT NULL,
  estado          TEXT NOT NULL DEFAULT 'disponible', -- disponible | reservado | vendido
  orden_id        TEXT,
  reservado_hasta TEXT,
  PRIMARY KEY (rifa_id, numero),
  FOREIGN KEY (rifa_id) REFERENCES rifas(id)
);

CREATE INDEX IF NOT EXISTS idx_ordenes_rifa ON ordenes(rifa_id);
CREATE INDEX IF NOT EXISTS idx_numeros_estado ON numeros(rifa_id, estado);
CREATE INDEX IF NOT EXISTS idx_numeros_orden ON numeros(orden_id);
`);

// Rifa de ejemplo — bórrala o reemplázala por tu panel de administración.
const seed = db.prepare('SELECT COUNT(*) AS n FROM rifas').get();
if (seed.n === 0) {
  const RIFA_ID = 'perfume-facil';

  db.prepare(`
    INSERT INTO rifas (id, nombre, precio_boleto, total_boletos, fecha_cierre)
    VALUES (?, ?, ?, ?, ?)
  `).run(RIFA_ID, 'Perfume Fácil — Primera Edición', 2500, 100, '2026-08-31T20:00:00');

  const insertPremio = db.prepare(`
    INSERT INTO premios (rifa_id, orden, nombre) VALUES (?, ?, ?)
  `);
  // El orden 1-4 define qué gana cada uno de los 4 ganadores distintos.
  insertPremio.run(RIFA_ID, 1, 'Botella completa sellada — Armaf Odyssey Dubai Chocolat 100ml');
  insertPremio.run(RIFA_ID, 2, 'Decant 10 ml a elección');
  insertPremio.run(RIFA_ID, 3, '2 decants de 5 ml a elección');
  insertPremio.run(RIFA_ID, 4, '2 decants de 3 ml a elección');

  const insertNumero = db.prepare(`
    INSERT INTO numeros (rifa_id, numero, estado) VALUES (?, ?, 'disponible')
  `);
  const sembrarNumeros = db.transaction(() => {
    for (let n = 1; n <= 100; n++) insertNumero.run(RIFA_ID, n);
  });
  sembrarNumeros();
}

module.exports = db;
