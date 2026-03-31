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
| `GET` | `/chat` | Fakechat-style browser chat UI (two-way with Claude) |

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

## MCP Channel Server (Claude Code integration)

The `channel/` directory contains an MCP Channel Server that bridges your running
Claude Code session with the CF Worker proxy — inspired by Claude Code's `fakechat` demo.

```
[Browser /chat UI]
      ↕ WebSocket
[CF Worker / Durable Object]         ← POST /webhook from any external service
      ↕ WebSocket
[MCP Channel Server (local)]
      ↕ stdio (MCP protocol)
[Claude Code session]
```

### Setup

**Requirements:** [Bun](https://bun.sh) + Claude Code ≥ v2.1.80 with claude.ai login

```bash
cd channel
bun install
```

Copy `.mcp.json.example` to `.mcp.json` in the project root and adjust URLs:

```bash
cp .mcp.json.example .mcp.json
```

Start the CF Worker locally, then launch Claude Code with the channel:

```bash
# Terminal 1
npm run dev                  # CF Worker at localhost:8787

# Terminal 2 — Claude Code with channel enabled
claude --dangerously-load-development-channels server:poc-ws-channel
```

Open the chat UI: `http://localhost:8787/chat`

Type a message → the MCP server forwards it to Claude Code → Claude replies back
in the chat UI via the `reply` tool.

### Environment Variables (channel server)

| Variable | Default | Description |
|---|---|---|
| `PROXY_WS_URL` | `ws://localhost:8787/ws` | WebSocket endpoint of the CF Worker |
| `PROXY_WEBHOOK_URL` | `http://localhost:8787/webhook` | Webhook POST endpoint |
| `PROXY_ROOM` | `default` | Room/channel name |

### Permission Relay

When Claude needs to run a tool (Bash, Write, etc.) while you're away from the terminal,
the permission prompt is forwarded to the chat UI. Click **Allow** or **Deny** to respond
remotely — Claude Code applies the first answer and closes the dialog.

### MCP Protocol Summary

| Direction | Mechanism | What it carries |
|---|---|---|
| External → Claude | `notifications/claude/channel` | Webhook payload or chat message |
| Claude → External | `reply` tool call | Claude's response text |
| Claude Code → Channel | `notifications/claude/channel/permission_request` | Tool approval prompt |
| External → Claude Code | `notifications/claude/channel/permission` | `allow` / `deny` verdict |

## Project Structure

```
poc-webhook-ws-proxy/
├── proxy/
│   ├── index.ts            Worker entry point — routing + env
│   └── durable-object.ts   WebSocket state + webhook broadcaster + chat UI
├── channel/
│   ├── channel.ts          MCP Channel Server (Claude Code ↔ CF Worker bridge)
│   ├── package.json        Bun deps (MCP SDK, zod)
│   └── tsconfig.json
├── client/
│   ├── client.py           Python WebSocket client example
│   └── requirements.txt
├── wrangler.toml
├── package.json
├── tsconfig.json
├── .mcp.json.example       Claude Code MCP config template
├── .dev.vars.example
└── .gitignore
```

## Architecture Notes

- **Durable Objects** provide single-threaded, consistent state per room — no race conditions when broadcasting.
- **WebSocket Hibernation API** (`state.acceptWebSocket`) lets the runtime hibernate the DO between events. Client IDs are stored as WebSocket _tags_ so they survive hibernation without an in-memory Map.
- **Room isolation** — each room name maps to a distinct Durable Object instance, so broadcasts never leak across rooms.

## License

MIT © 2024 — see [LICENSE](LICENSE).
