# cf-webhook-ws-proxy

> Open-source Cloudflare Workers proxy that receives HTTP webhooks and broadcasts them to connected WebSocket clients in real-time.

```
[External Service] → POST /webhook → [CF Worker] → [Durable Object] → [WebSocket Clients]
```

## Features

- **Zero-infra relay** — runs entirely on Cloudflare's edge, no servers to manage
- **WebSocket Hibernation** — Durable Object sleeps between events, billed only for active CPU time
- **Room/channel system** — append `?room=<name>` to scope connections and webhooks
- **Multiple concurrent clients** — broadcast to all connected clients in a room simultaneously
- **Simple dashboard** — visit `/dashboard` to see connected clients and rooms
- **CORS-ready** — webhook endpoint accepts cross-origin POST requests

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check — returns `{ status: "ok" }` |
| `GET` | `/ws` | WebSocket upgrade endpoint |
| `POST` | `/webhook` | Receive a webhook and broadcast to connected clients |
| `GET` | `/dashboard` | Live dashboard (auto-refreshes every 10 s) |

All endpoints accept an optional `?room=<name>` query parameter (default: `default`).

## WebSocket Protocol

### Server → Client

**On connect:**
```json
{ "type": "connected", "clientId": "uuid", "room": "default", "timestamp": "..." }
```

**On webhook received:**
```json
{ "type": "webhook", "body": { ... }, "timestamp": "...", "source": "...", "room": "default" }
```

**Pong (reply to ping):**
```json
{ "type": "pong", "timestamp": "..." }
```

### Client → Server

**Ping:**
```json
{ "type": "ping" }
```

**Reply (arbitrary data):**
```json
{ "type": "reply", "data": { ... } }
```

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Local development

```bash
cp .dev.vars.example .dev.vars   # fill in secrets if needed
npm run dev                       # starts at http://localhost:8787
```

### 3. Deploy to Cloudflare

```bash
# Login (one-time)
npx wrangler login

# Deploy
npm run deploy
```

### 4. (Optional) Add LINE secrets

```bash
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put LINE_CHANNEL_TOKEN
```

## Python Client

```bash
pip install -r client/requirements.txt
python client/client.py --url wss://your-worker.workers.dev/ws --room my-room
```

### Options

```
--url             WebSocket endpoint   (default: ws://localhost:8787/ws)
--room            Room name            (default: default)
--ping-interval   Heartbeat in seconds (default: 30)
```

The client auto-reconnects with exponential back-off (2 s → 4 s → … → 60 s max).

## Send a Test Webhook

```bash
# Local
curl -X POST http://localhost:8787/webhook \
  -H "Content-Type: application/json" \
  -d '{"event": "test", "message": "hello from curl"}'

# Production (default room)
curl -X POST https://your-worker.workers.dev/webhook \
  -H "Content-Type: application/json" \
  -d '{"event": "order.created", "orderId": 42}'

# Specific room
curl -X POST https://your-worker.workers.dev/webhook?room=orders \
  -H "Content-Type: application/json" \
  -d '{"event": "order.created", "orderId": 42}'
```

## Project Structure

```
cf-webhook-ws-proxy/
├── proxy/
│   ├── index.ts            Worker entry point — routing + env
│   └── durable-object.ts   WebSocket state manager
├── client/
│   ├── client.py           Python example client
│   └── requirements.txt
├── wrangler.toml
├── package.json
├── tsconfig.json
├── .dev.vars.example
└── .gitignore
```

## Architecture Notes

- **Durable Objects** provide single-threaded, consistent state per room — no race conditions when broadcasting.
- **WebSocket Hibernation API** (`state.acceptWebSocket`) lets the runtime hibernate the DO between events. Client IDs are stored as WebSocket _tags_ so they survive hibernation without an in-memory Map.
- **Room isolation** — each room name maps to a distinct Durable Object instance, so broadcasts never leak across rooms.

## License

MIT © 2024 — see [LICENSE](LICENSE).
