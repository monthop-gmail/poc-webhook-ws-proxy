# poc-webhook-ws-proxy

> Cloudflare Workers proxy รับ HTTP webhook แล้ว broadcast real-time ไปยัง WebSocket clients
> พร้อม MCP Channel Server ให้ Claude Code ตอบสนองต่อ events ได้โดยตรง

```
[External Service]
      │ POST /webhook
      ▼
[CF Worker + Durable Object]  ──broadcast──►  [WebSocket Clients]
      │                                              │
      │ WebSocket                           [Browser /chat UI]
      ▼
[MCP Channel Server]
      │ stdio (MCP protocol)
      ▼
[Claude Code Session]  ──reply tool──►  [CF Worker]  ──►  [Chat UI]
```

## Quick Start (5 นาที)

### 1. Clone & install

```bash
git clone https://github.com/monthop-gmail/poc-webhook-ws-proxy
cd poc-webhook-ws-proxy
npm install
```

### 2. รัน CF Worker local

```bash
npm run dev
# Worker พร้อมที่ http://localhost:8787
```

### 3. ทดสอบ webhook (ไม่ต้องใช้ Claude)

```bash
# Terminal 2 — Python client รับ events
pip install websockets
python client/client.py

# Terminal 3 — ส่ง webhook
curl -X POST http://localhost:8787/webhook \
  -H "Content-Type: application/json" \
  -d '{"event": "test", "message": "hello!"}'
```

เปิด dashboard: http://localhost:8787/dashboard

---

## Setup MCP Channel (Claude Code integration)

> ให้ Claude Code ตอบสนองต่อ webhook events และ chat messages แบบ real-time

### Requirements
- [Bun](https://bun.sh) — `bun --version`
- Claude Code ≥ v2.1.80 (`claude --version`)
- login ด้วย claude.ai account

### 1. Install channel dependencies

```bash
cd channel && bun install && cd ..
```

### 2. สร้าง MCP config

```bash
cp .mcp.json.example .mcp.json
```

`.mcp.json` (แก้ URL ถ้า deploy ขึ้น Cloudflare แล้ว):
```json
{
  "mcpServers": {
    "poc-ws-channel": {
      "command": "bun",
      "args": ["./channel/channel.ts"],
      "env": {
        "PROXY_WS_URL":      "ws://localhost:8787/ws",
        "PROXY_WEBHOOK_URL": "http://localhost:8787/webhook",
        "PROXY_ROOM":        "default"
      }
    }
  }
}
```

### 3. Start Claude Code with channel

```bash
claude --dangerously-load-development-channels server:poc-ws-channel
```

### 4. เปิด Chat UI

```
http://localhost:8787/chat
```

พิมพ์ข้อความ → Claude ตอบกลับใน browser ✨

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/ws` | WebSocket connection |
| `POST` | `/webhook` | รับ webhook → broadcast ทุก client |
| `GET` | `/chat` | Chat UI (fakechat-style) |
| `GET` | `/dashboard` | Live dashboard |

ทุก endpoint รองรับ `?room=<name>` (default: `default`)

---

## WebSocket Protocol

### Server → Client

```jsonc
// เมื่อ connect
{ "type": "connected", "clientId": "uuid", "room": "default" }

// เมื่อมี webhook
{ "type": "webhook", "body": { ... }, "timestamp": "...", "source": "..." }
```

### Client → Server

```jsonc
{ "type": "ping" }
{ "type": "reply", "data": { ... } }
```

---

## MCP Channel Protocol

```
External event  ──POST /webhook──►  CF Worker  ──WebSocket──►  MCP Server
                                                                    │ notifications/claude/channel
                                                              Claude Code
                                                                    │ reply tool call
External UI     ◄──WebSocket──  CF Worker  ◄──POST /webhook──  MCP Server
```

| Flow | Method |
|------|--------|
| Event เข้า Claude | `notifications/claude/channel` |
| Claude ตอบกลับ | `reply` tool → POST /webhook |
| Permission request | `notifications/claude/channel/permission_request` |
| Approve/Deny | `notifications/claude/channel/permission` |

---

## Deploy to Cloudflare

### 1. Deploy

```bash
# Login (ครั้งแรก)
npx wrangler login

# Deploy
npm run deploy
```

Wrangler จะ print URL ออกมาหลัง deploy เสร็จ:

```
Published cf-webhook-ws-proxy (1.23 sec)
  https://cf-webhook-ws-proxy.<your-subdomain>.workers.dev
```

`<your-subdomain>` คือ account subdomain ของ Cloudflare
ดูได้ที่ [Cloudflare Dashboard → Workers & Pages → Overview]

### 2. Production URLs

| ใช้ทำอะไร | URL |
|---|---|
| Webhook (รับ event จากระบบนอก) | `https://cf-webhook-ws-proxy.xxx.workers.dev/webhook` |
| WebSocket (MCP channel / client) | `wss://cf-webhook-ws-proxy.xxx.workers.dev/ws` |
| Chat UI | `https://cf-webhook-ws-proxy.xxx.workers.dev/chat` |
| Dashboard | `https://cf-webhook-ws-proxy.xxx.workers.dev/dashboard` |
| Health check | `https://cf-webhook-ws-proxy.xxx.workers.dev/health` |

> **หมายเหตุ:** บน production ใช้ `https://` และ `wss://` เสมอ (TLS)
> บน local dev ใช้ `http://` และ `ws://`

### 3. อัพเดต .mcp.json

```json
{
  "mcpServers": {
    "poc-ws-channel": {
      "command": "bun",
      "args": ["./channel/channel.ts"],
      "env": {
        "PROXY_WS_URL":      "wss://cf-webhook-ws-proxy.xxx.workers.dev/ws",
        "PROXY_WEBHOOK_URL": "https://cf-webhook-ws-proxy.xxx.workers.dev/webhook",
        "PROXY_ROOM":        "default"
      }
    }
  }
}
```

### 4. ทดสอบ production

```bash
# Health check
curl https://cf-webhook-ws-proxy.xxx.workers.dev/health

# ส่ง test webhook
curl -X POST https://cf-webhook-ws-proxy.xxx.workers.dev/webhook \
  -H "Content-Type: application/json" \
  -d '{"event": "test", "message": "hello from production!"}'
```

---

## Background Agent (Always-on)

รัน Claude เป็น agent ที่ตอบสนองตลอดเวลา:

```bash
# tmux (development)
bash examples/05-background/start-tmux.sh start

# systemd (production)
sudo cp examples/05-background/claude-agent.service /etc/systemd/system/
sudo systemctl enable --now claude-agent
```

บอก Claude ว่าต้องทำอะไร:
```bash
cp examples/05-background/CLAUDE.md.example CLAUDE.md
# แก้ให้ตรงกับ project จริง
```

---

## Examples

ดู [`examples/`](./examples/README.md) สำหรับ demo แต่ละ scenario:

| Example | Description |
|---------|-------------|
| [01-basic-chat](./examples/01-basic-chat/) | ส่ง message ธรรมดา |
| [02-line-webhook](./examples/02-line-webhook/) | จำลอง LINE Messaging API |
| [03-ci-alert](./examples/03-ci-alert/) | GitHub Actions build/test/deploy |
| [04-permission-relay](./examples/04-permission-relay/) | Approve tool จาก browser |
| [05-background](./examples/05-background/) | Always-on agent (tmux/systemd) |

---

## Project Structure

```
poc-webhook-ws-proxy/
├── proxy/
│   ├── index.ts               Worker entry point
│   └── durable-object.ts      WebSocket state + webhook broadcast + chat UI
├── channel/
│   ├── channel.ts             MCP Channel Server
│   ├── package.json
│   └── tsconfig.json
├── client/
│   ├── client.py              Python WebSocket client
│   └── requirements.txt
├── examples/
│   ├── 01-basic-chat/
│   ├── 02-line-webhook/
│   ├── 03-ci-alert/
│   ├── 04-permission-relay/
│   └── 05-background/         tmux script + systemd service + CLAUDE.md template
├── wrangler.toml
├── package.json
├── tsconfig.json
├── .mcp.json.example
└── .dev.vars.example
```

---

## License

MIT
