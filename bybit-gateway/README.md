# NeurlX Bybit Regional Gateway

Deploy this service in a Bybit-supported region such as Nigeria, Singapore, UAE, or Japan.

NeurlX signs Bybit requests inside the main app, then this gateway forwards the already-signed headers/body to Bybit from the allowed region. The gateway does **not** need the Bybit API secret.

## Environment

- `GATEWAY_SHARED_SECRET` — same shared secret saved on the NeurlX Bybit connection.
- `BYBIT_API_BASE` — optional, defaults to `https://api.bybit.com`.
- `GATEWAY_REGION` — display label such as `Nigeria` or `Singapore`.
- `PORT` — defaults to `8787`.

## Endpoints

- `GET /health`
- `POST /bybit`