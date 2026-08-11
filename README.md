# Rifa Esencia — Backend

Backend mínimo para vender boletos de rifa verificando el pago con **Webpay Plus (Transbank)**
antes de emitir cualquier boleto.

## Cómo funciona el flujo (lo importante)

1. `POST /api/ordenes` — crea la orden con estado `pendiente`. **No reserva ningún número de boleto.**
2. `POST /api/pago/iniciar` — abre la transacción en Transbank (`Transaction.create`) y devuelve la URL de pago.
3. El comprador paga en Transbank. Transbank redirige de vuelta a `POST /api/pago/retorno`.
4. `pago/retorno` llama a `Transaction.commit(token)`. **Solo si** Transbank responde `response_code === 0`
   y `status === "AUTHORIZED"` (y el monto/orden calzan), el backend marca la orden como `pagado`
   y recién ahí numera los boletos, dentro de una transacción de base de datos.
5. Si el pago es rechazado, anulado o falla, la orden queda `rechazado` y **ningún boleto se crea**.

Este orden importa: el boleto nunca se emite desde el navegador del comprador ni antes del `commit()`.

## Instalación

```bash
npm install
cp .env.example .env
```

Con `TBK_ENV=integration` (valor por defecto) usas el ambiente de pruebas de Transbank,
que ya trae credenciales de comercio y tarjetas de prueba — no necesitas cuenta real todavía.
Tarjetas y flujo de prueba: la documentación oficial de Transbank las publica en su portal de
desarrolladores (buscar "Webpay Plus integración" y "tarjetas de prueba").

```bash
npm start
```

El servidor queda escuchando en `http://localhost:3000`.

## Probar los endpoints

```bash
# Ver disponibilidad
curl http://localhost:3000/api/rifas/esencia-6/estado

# Crear una orden
curl -X POST http://localhost:3000/api/ordenes \
  -H "Content-Type: application/json" \
  -d '{"rifaId":"esencia-6","nombre":"María Torres","email":"maria@correo.com","cantidad":2}'

# Iniciar el pago (requiere el ordenId de la respuesta anterior)
curl -X POST http://localhost:3000/api/pago/iniciar \
  -H "Content-Type: application/json" \
  -d '{"ordenId":"<el-id-que-recibiste>"}'
```

La respuesta de `pago/iniciar` trae `{ url, token }`. En el navegador esto se resuelve con un
formulario que se autoenvía por POST:

```html
<form id="wp" method="POST" :action="url">
  <input type="hidden" name="token_ws" :value="token">
</form>
<script>document.getElementById('wp').submit()</script>
```

(Webpay Plus exige que ese salto sea un POST, no un `window.location = url`.)

## Conectar con el prototipo de frontend

El archivo `rifa-perfume-demo.html` que armamos antes simula todo esto en el navegador porque
no tenía backend. El siguiente paso natural es reemplazar sus funciones `openWebpayMock`,
`showVerifying`, etc. por llamadas reales a:

- `POST /api/ordenes` al hacer clic en "Pagar con Webpay Plus"
- `POST /api/pago/iniciar` y redirigir al formulario autoenviado
- Una página `resultado.html` que lea `?orden=...&estado=...` de la URL (así es como
  `pago/retorno` te devuelve al frontend) y muestre el boleto o el rechazo según corresponda

Puedo dejarte esa integración lista si quieres — dime y seguimos por ahí.

## Pasar a producción

1. Afíliate como comercio en Transbank y obtén tu `TBK_COMMERCE_CODE` y `TBK_API_KEY` reales.
2. En `.env`: `TBK_ENV=production`, y completa esas dos variables.
3. `TBK_RETURN_URL` debe ser una URL pública HTTPS de tu servidor.
4. Migra `rifa.db` (SQLite) a Postgres o MySQL si esperas más de un servidor corriendo a la vez
   — la lógica de `db.transaction(...)` en `routes/pago.js` es la misma, solo cambia el driver.
5. Agrega autenticación/rol de administrador antes de exponer cualquier endpoint que liste
   compradores o permita crear/editar rifas.

## Estructura

```
rifa-backend/
├── server.js          # arranque de Express
├── db.js              # esquema SQLite (rifas, ordenes, boletos)
├── routes/
│   ├── ordenes.js      # crear orden, consultar disponibilidad
│   └── pago.js         # iniciar y confirmar pago con Transbank
└── .env.example
```
