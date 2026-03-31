#!/usr/bin/env bun
/**
 * poc-webhook-ws-proxy — MCP Channel Server
 *
 * Bridges a running Claude Code session with the CF Worker proxy:
 *   CF Worker WebSocket → MCP notification → Claude Code session
 *   Claude Code reply tool → POST /webhook → CF Worker → all chat clients
 *
 * Setup:
 *   bun install
 *   Add .mcp.json (see .mcp.json.example)
 *   claude --dangerously-load-development-channels server:poc-ws-channel
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

// ─── Config ──────────────────────────────────────────────────────────────────

const WS_URL      = process.env.PROXY_WS_URL      ?? 'ws://localhost:8787/ws'
const WEBHOOK_URL = process.env.PROXY_WEBHOOK_URL ?? 'http://localhost:8787/webhook'
const ROOM        = process.env.PROXY_ROOM        ?? 'default'

// ─── MCP Server ──────────────────────────────────────────────────────────────

const mcp = new Server(
  { name: 'poc-ws-channel', version: '1.0.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},           // register as a channel
        'claude/channel/permission': {}, // opt-in to permission relay
      },
      tools: {},                        // two-way: expose reply tool
    },
    instructions: `
You are connected to a webhook-to-WebSocket proxy channel (room: "${ROOM}").

Inbound events arrive as:
  <channel source="poc-ws-channel" chat_id="N" room="${ROOM}" event_source="...">
    { ...payload }
  </channel>

Rules:
- Respond to user messages using the reply tool, passing back the chat_id.
- If the payload has type "ping" just reply with a friendly pong.
- For webhook events (CI, alerts, etc.) summarise and optionally act on them.
- Permission prompts are forwarded to the chat UI automatically; wait for approval.
    `.trim(),
  },
)

// ─── Reply Tool ───────────────────────────────────────────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Send a message back through the webhook-ws-proxy channel to the chat UI.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: { type: 'string', description: 'chat_id from the inbound <channel> tag' },
          text:    { type: 'string', description: 'Reply text (markdown supported)' },
        },
        required: ['chat_id', 'text'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'reply') throw new Error(`Unknown tool: ${req.params.name}`)

  const { chat_id, text } = req.params.arguments as { chat_id: string; text: string }

  const res = await fetch(`${WEBHOOK_URL}?room=${ROOM}`, {
    method: 'POST',
    headers: {
      'Content-Type':    'application/json',
      'X-Webhook-Source': 'claude-reply',
    },
    body: JSON.stringify({ type: 'reply', chat_id, text }),
  })

  if (!res.ok) {
    throw new Error(`Proxy returned ${res.status}: ${await res.text()}`)
  }

  return { content: [{ type: 'text' as const, text: 'sent' }] }
})

// ─── Permission Relay ─────────────────────────────────────────────────────────
// Claude Code notifies us when a tool-approval dialog opens.
// We forward it to the chat UI via the proxy so the user can approve remotely.

const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id:    z.string(),
    tool_name:     z.string(),
    description:   z.string(),
    input_preview: z.string(),
  }),
})

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  await fetch(`${WEBHOOK_URL}?room=${ROOM}`, {
    method: 'POST',
    headers: {
      'Content-Type':    'application/json',
      'X-Webhook-Source': 'permission-relay',
    },
    body: JSON.stringify({
      type:          'permission_request',
      tool_name:     params.tool_name,
      description:   params.description,
      input_preview: params.input_preview,
      request_id:    params.request_id,
    }),
  }).catch((err) => console.error('[channel] permission relay fetch failed:', err))
})

// ─── Connect to Claude Code ───────────────────────────────────────────────────

await mcp.connect(new StdioServerTransport())

// ─── WebSocket → Claude Code Bridge ──────────────────────────────────────────
// Regex: "yes abcde" / "no abcde" (5 letters, never 'l' — Claude Code's ID alphabet)

const VERDICT_RE = /^\s*(y(?:es)?|n(?:o)?)\s+([a-km-z]{5})\s*$/i

let chatCounter = 0

function connectWebSocket(): void {
  const url = `${WS_URL}?room=${encodeURIComponent(ROOM)}`
  const ws   = new WebSocket(url)

  ws.addEventListener('open', () => {
    console.error(`[channel] connected to proxy  room=${ROOM}  url=${url}`)
  })

  ws.addEventListener('message', async (event: MessageEvent) => {
    let envelope: Record<string, unknown>
    try {
      envelope = JSON.parse(event.data as string)
    } catch {
      return // ignore non-JSON frames
    }

    // ── Skip non-webhook frames ──
    if (envelope.type !== 'webhook') return

    const body = envelope.body

    // ── Skip our own outbound traffic ──
    if (typeof body === 'object' && body !== null) {
      const b = body as Record<string, unknown>
      if (b.type === 'reply' || b.type === 'permission_request') return
    }

    // ── Coerce body to a string for analysis ──
    const bodyText = (typeof body === 'string' ? body : JSON.stringify(body)).trim()

    // ── Permission verdict? ──
    const verdict = VERDICT_RE.exec(bodyText)
    if (verdict) {
      await mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: {
          request_id: verdict[2].toLowerCase(),
          behavior:   verdict[1].toLowerCase().startsWith('y') ? 'allow' : 'deny',
        },
      }).catch((err) => console.error('[channel] verdict notification failed:', err))
      return
    }

    // ── Regular message — forward to Claude Code ──
    const chatId = String(++chatCounter)

    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: typeof body === 'string' ? body : JSON.stringify(body, null, 2),
        meta: {
          chat_id:      chatId,
          room:         String(envelope.room ?? ROOM),
          event_source: String(envelope.source ?? 'unknown'),
        },
      },
    }).catch((err) => console.error('[channel] channel notification failed:', err))
  })

  ws.addEventListener('close', (ev: CloseEvent) => {
    console.error(`[channel] WebSocket closed  code=${ev.code}  reconnecting in 3 s…`)
    setTimeout(connectWebSocket, 3_000)
  })

  ws.addEventListener('error', () => {
    console.error('[channel] WebSocket error — will retry on close')
  })
}

connectWebSocket()
