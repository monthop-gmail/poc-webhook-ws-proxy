export interface Env {
  WEBSOCKET_PROXY: DurableObjectNamespace;
}

interface WebhookPayload {
  type: 'webhook';
  body: unknown;
  timestamp: string;
  source?: string;
  room: string;
}

interface ConnectedPayload {
  type: 'connected';
  clientId: string;
  room: string;
  timestamp: string;
}

interface PongPayload {
  type: 'pong';
  timestamp: string;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Webhook-Source',
};

/**
 * WebSocketProxy — Durable Object that manages WebSocket connections and
 * broadcasts incoming webhook payloads to all connected clients.
 *
 * Uses WebSocket Hibernation API so the DO sleeps between events and you
 * only pay for active CPU time.
 */
export class WebSocketProxy implements DurableObject {
  private readonly state: DurableObjectState;
  private readonly env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  // ─── Routing ────────────────────────────────────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const room = url.searchParams.get('room') || 'default';

    switch (true) {
      case url.pathname === '/ws' && request.method === 'GET':
        return this.handleWebSocketUpgrade(request, room);

      case url.pathname === '/webhook' && request.method === 'POST':
        return this.handleWebhook(request, room);

      case url.pathname === '/webhook' && request.method === 'OPTIONS':
        return new Response(null, { status: 204, headers: CORS_HEADERS });

      case url.pathname === '/dashboard' && request.method === 'GET':
        return this.handleDashboard(room);

      default:
        return new Response('Not Found', { status: 404 });
    }
  }

  // ─── WebSocket Upgrade ───────────────────────────────────────────────────────

  private handleWebSocketUpgrade(request: Request, room: string): Response {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 });
    }

    const clientId = crypto.randomUUID();
    const { 0: client, 1: server } = new WebSocketPair();

    // acceptWebSocket enables hibernation — the DO can sleep between messages
    // Tags allow us to retrieve the clientId without an in-memory Map
    this.state.acceptWebSocket(server, [clientId, room]);

    const welcome: ConnectedPayload = {
      type: 'connected',
      clientId,
      room,
      timestamp: new Date().toISOString(),
    };
    // Send welcome immediately before hibernation kicks in
    server.send(JSON.stringify(welcome));

    console.log(`[ws] client connected clientId=${clientId} room=${room}`);

    return new Response(null, { status: 101, webSocket: client });
  }

  // ─── WebSocket Hibernation Handlers ──────────────────────────────────────────

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const [clientId] = this.state.getTags(ws);
    let data: Record<string, unknown>;

    try {
      const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
      data = JSON.parse(text);
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    switch (data.type) {
      case 'ping': {
        const pong: PongPayload = { type: 'pong', timestamp: new Date().toISOString() };
        ws.send(JSON.stringify(pong));
        break;
      }
      case 'reply':
        // Echo replies back with the sender's clientId attached
        console.log(`[ws] reply from clientId=${clientId}`, data);
        break;
      default:
        console.warn(`[ws] unknown message type="${data.type}" from clientId=${clientId}`);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    const [clientId, room] = this.state.getTags(ws);
    console.log(`[ws] client disconnected clientId=${clientId} room=${room} code=${code} reason=${reason}`);
    ws.close(code, 'Closing');
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    const [clientId] = this.state.getTags(ws);
    console.error(`[ws] error clientId=${clientId}`, error);
    ws.close(1011, 'Internal error');
  }

  // ─── Webhook Handler ─────────────────────────────────────────────────────────

  private async handleWebhook(request: Request, room: string): Promise<Response> {
    let body: unknown;
    const contentType = request.headers.get('Content-Type') ?? '';

    try {
      if (contentType.includes('application/json')) {
        body = await request.json();
      } else if (contentType.includes('application/x-www-form-urlencoded')) {
        const text = await request.text();
        body = Object.fromEntries(new URLSearchParams(text));
      } else {
        body = await request.text();
      }
    } catch {
      return Response.json(
        { success: false, error: 'Failed to parse request body' },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const source = request.headers.get('X-Webhook-Source') ?? request.headers.get('User-Agent') ?? 'unknown';

    const payload: WebhookPayload = {
      type: 'webhook',
      body,
      timestamp: new Date().toISOString(),
      source,
      room,
    };

    const sockets = this.state.getWebSockets();
    // Filter to only sockets in this room
    const roomSockets = sockets.filter((ws) => {
      const tags = this.state.getTags(ws);
      return tags[1] === room;
    });

    let sent = 0;
    const message = JSON.stringify(payload);

    for (const ws of roomSockets) {
      try {
        ws.send(message);
        sent++;
      } catch (err) {
        const [clientId] = this.state.getTags(ws);
        console.error(`[webhook] failed to send to clientId=${clientId}`, err);
      }
    }

    console.log(`[webhook] broadcast room=${room} clients=${sent}/${roomSockets.length}`);

    return Response.json(
      {
        success: true,
        room,
        clients_notified: sent,
        timestamp: new Date().toISOString(),
      },
      { headers: CORS_HEADERS }
    );
  }

  // ─── Dashboard ───────────────────────────────────────────────────────────────

  private handleDashboard(currentRoom: string): Response {
    const sockets = this.state.getWebSockets();

    type ClientInfo = { clientId: string; room: string };
    const clients: ClientInfo[] = sockets.map((ws) => {
      const [clientId, room] = this.state.getTags(ws);
      return { clientId, room };
    });

    const roomCounts = clients.reduce<Record<string, number>>((acc, c) => {
      acc[c.room] = (acc[c.room] ?? 0) + 1;
      return acc;
    }, {});

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>cf-webhook-ws-proxy — Dashboard</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Courier New', monospace;
      background: #0d1117;
      color: #e6edf3;
      padding: 24px;
      line-height: 1.6;
    }
    h1 { color: #58a6ff; font-size: 1.4rem; margin-bottom: 4px; }
    .subtitle { color: #8b949e; font-size: 0.85rem; margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 16px;
    }
    .card .label { font-size: 0.75rem; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; }
    .card .value { font-size: 2rem; font-weight: bold; color: #3fb950; margin-top: 4px; }
    .card .value.blue { color: #58a6ff; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    th {
      text-align: left;
      padding: 8px 12px;
      background: #161b22;
      color: #8b949e;
      border-bottom: 1px solid #30363d;
      font-weight: normal;
      text-transform: uppercase;
      font-size: 0.75rem;
      letter-spacing: 0.05em;
    }
    td { padding: 8px 12px; border-bottom: 1px solid #21262d; }
    tr:last-child td { border-bottom: none; }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 0.75rem;
      background: #1f6feb33;
      color: #58a6ff;
      border: 1px solid #1f6feb66;
    }
    .dot { color: #3fb950; margin-right: 6px; }
    .section-title { color: #8b949e; font-size: 0.85rem; margin: 24px 0 8px; text-transform: uppercase; letter-spacing: 0.05em; }
    .empty { color: #484f58; padding: 16px 12px; font-style: italic; }
    .refresh { color: #8b949e; font-size: 0.75rem; margin-top: 24px; }
    a { color: #58a6ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>⚡ cf-webhook-ws-proxy</h1>
  <p class="subtitle">Cloudflare Workers + Durable Objects · Real-time Webhook Relay</p>

  <div class="grid">
    <div class="card">
      <div class="label">Total Connections</div>
      <div class="value">${clients.length}</div>
    </div>
    <div class="card">
      <div class="label">Active Rooms</div>
      <div class="value blue">${Object.keys(roomCounts).length}</div>
    </div>
    <div class="card">
      <div class="label">Current Room</div>
      <div class="value blue" style="font-size:1.2rem;padding-top:8px">${currentRoom}</div>
    </div>
  </div>

  <div class="section-title">Rooms</div>
  <table>
    <thead>
      <tr><th>Room</th><th>Clients</th><th>Webhook Endpoint</th></tr>
    </thead>
    <tbody>
      ${
        Object.entries(roomCounts).length > 0
          ? Object.entries(roomCounts)
              .map(
                ([room, count]) => `
        <tr>
          <td><span class="dot">●</span>${room}</td>
          <td><span class="badge">${count}</span></td>
          <td><code>/webhook?room=${room}</code></td>
        </tr>`
              )
              .join('')
          : `<tr><td colspan="3" class="empty">No active rooms</td></tr>`
      }
    </tbody>
  </table>

  <div class="section-title">Connected Clients</div>
  <table>
    <thead>
      <tr><th>Client ID</th><th>Room</th></tr>
    </thead>
    <tbody>
      ${
        clients.length > 0
          ? clients
              .map(
                (c) => `
        <tr>
          <td><code>${c.clientId}</code></td>
          <td><span class="badge">${c.room}</span></td>
        </tr>`
              )
              .join('')
          : `<tr><td colspan="2" class="empty">No clients connected</td></tr>`
      }
    </tbody>
  </table>

  <p class="refresh">
    Last updated: ${new Date().toISOString()} ·
    <a href="?room=${currentRoom}">Refresh</a> ·
    <a href="/health">Health Check</a>
  </p>

  <script>
    // Auto-refresh every 10 seconds
    setTimeout(() => location.reload(), 10000);
  </script>
</body>
</html>`;

    return new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}
