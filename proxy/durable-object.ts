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
  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
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

      case url.pathname === '/chat' && request.method === 'GET':
        return this.handleChat(room);

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

  // ─── Chat UI (fakechat-style) ─────────────────────────────────────────────
  // Two-way chat interface: connects via WebSocket, sends messages as webhooks.
  // Works as a browser frontend for the MCP Channel Server.

  private handleChat(room: string): Response {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>cf-webhook-ws-proxy · Chat · ${room}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0d1117; --surface: #161b22; --border: #30363d;
      --text: #e6edf3; --muted: #8b949e; --green: #3fb950;
      --blue: #58a6ff; --yellow: #d29922; --red: #f85149;
      --purple: #bc8cff; --radius: 8px;
    }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', monospace;
           background: var(--bg); color: var(--text); height: 100dvh;
           display: flex; flex-direction: column; overflow: hidden; }

    /* ── Top bar ── */
    header { display: flex; align-items: center; gap: 10px;
             padding: 12px 16px; border-bottom: 1px solid var(--border);
             background: var(--surface); flex-shrink: 0; }
    header h1 { font-size: 0.95rem; font-weight: 600; color: var(--blue); }
    .room-badge { font-size: 0.75rem; background: #1f6feb33; color: var(--blue);
                  border: 1px solid #1f6feb66; border-radius: 12px; padding: 2px 10px; }
    #status { margin-left: auto; font-size: 0.78rem; color: var(--muted);
              display: flex; align-items: center; gap: 6px; }
    #status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
    #status-dot.ok  { background: var(--green); box-shadow: 0 0 6px var(--green); }
    #status-dot.err { background: var(--red); }

    /* ── Message list ── */
    #messages { flex: 1; overflow-y: auto; padding: 16px; display: flex;
                flex-direction: column; gap: 10px; }
    .msg { display: flex; flex-direction: column; gap: 4px; max-width: 85%; }
    .msg.me    { align-self: flex-end; align-items: flex-end; }
    .msg.claude { align-self: flex-start; }
    .msg.event  { align-self: center; max-width: 95%; }
    .msg.system { align-self: center; }
    .msg.permission { align-self: center; max-width: 95%; }

    .bubble { padding: 10px 14px; border-radius: var(--radius); font-size: 0.88rem;
              line-height: 1.5; word-break: break-word; white-space: pre-wrap; }
    .me     .bubble { background: #1f6feb; color: #fff; border-bottom-right-radius: 2px; }
    .claude .bubble { background: var(--surface); border: 1px solid var(--border);
                      border-bottom-left-radius: 2px; }
    .event  .bubble { background: #161b22; border: 1px solid var(--border);
                      font-family: monospace; font-size: 0.8rem; color: var(--muted);
                      width: 100%; }
    .system .bubble { background: transparent; color: var(--muted); font-size: 0.78rem;
                      font-style: italic; text-align: center; }
    .permission .bubble { background: #2d1f00; border: 1px solid var(--yellow);
                          border-radius: var(--radius); width: 100%; }

    .label { font-size: 0.72rem; color: var(--muted); padding: 0 4px; }
    .label.blue   { color: var(--blue); }
    .label.green  { color: var(--green); }
    .label.yellow { color: var(--yellow); }

    /* ── Permission prompt ── */
    .perm-header { color: var(--yellow); font-weight: 600; font-size: 0.85rem;
                   margin-bottom: 6px; }
    .perm-tool   { font-family: monospace; background: #ffffff10; padding: 2px 6px;
                   border-radius: 4px; }
    .perm-desc   { font-size: 0.83rem; color: var(--text); margin: 4px 0; }
    .perm-preview { font-family: monospace; font-size: 0.78rem; color: var(--muted);
                    margin: 6px 0; padding: 6px; background: #0d1117;
                    border-radius: 4px; white-space: pre-wrap; word-break: break-all; }
    .perm-actions { display: flex; gap: 8px; margin-top: 10px; }
    .btn { padding: 6px 16px; border-radius: 6px; border: none; cursor: pointer;
           font-size: 0.83rem; font-weight: 600; transition: opacity 0.15s; }
    .btn:hover { opacity: 0.85; }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn.allow { background: var(--green); color: #0d1117; }
    .btn.deny  { background: #21262d; color: var(--text); border: 1px solid var(--border); }
    .perm-id   { font-size: 0.72rem; color: var(--muted); margin-top: 4px; font-family: monospace; }

    /* ── Input bar ── */
    footer { padding: 12px 16px; border-top: 1px solid var(--border);
             background: var(--surface); flex-shrink: 0; }
    #form { display: flex; gap: 8px; }
    #input { flex: 1; background: var(--bg); border: 1px solid var(--border);
             border-radius: 6px; color: var(--text); padding: 10px 14px;
             font-size: 0.9rem; outline: none; resize: none; min-height: 42px;
             max-height: 120px; font-family: inherit; }
    #input:focus { border-color: var(--blue); }
    #input::placeholder { color: var(--muted); }
    #send { background: var(--blue); color: #0d1117; border: none;
            border-radius: 6px; padding: 10px 18px; font-weight: 600;
            font-size: 0.88rem; cursor: pointer; transition: opacity 0.15s;
            align-self: flex-end; }
    #send:hover { opacity: 0.85; }
    #send:disabled { opacity: 0.4; cursor: not-allowed; }
  </style>
</head>
<body>
<header>
  <h1>⚡ poc-webhook-ws-proxy</h1>
  <span class="room-badge">${room}</span>
  <div id="status">
    <span id="status-dot"></span>
    <span id="status-text">connecting…</span>
  </div>
</header>

<div id="messages"></div>

<footer>
  <form id="form">
    <textarea id="input" placeholder="Type a message… (Enter to send, Shift+Enter for newline)" rows="1"></textarea>
    <button type="submit" id="send" disabled>Send</button>
  </form>
</footer>

<script>
(function () {
  const ROOM = ${JSON.stringify(room)};
  const msgList = document.getElementById('messages');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const form = document.getElementById('form');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');

  // ── WebSocket ──────────────────────────────────────────────────────────────
  let ws;
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws?room=' + encodeURIComponent(ROOM));

    ws.onopen = () => {
      setStatus('ok', 'connected');
      sendBtn.disabled = false;
    };

    ws.onclose = () => {
      setStatus('err', 'disconnected — reconnecting…');
      sendBtn.disabled = true;
      setTimeout(connect, 3000);
    };

    ws.onerror = () => setStatus('err', 'connection error');

    ws.onmessage = (ev) => {
      let envelope;
      try { envelope = JSON.parse(ev.data); } catch { return; }
      handleEnvelope(envelope);
    };
  }

  function setStatus(state, text) {
    statusDot.className = state;
    statusText.textContent = text;
  }

  // ── Message rendering ─────────────────────────────────────────────────────
  function handleEnvelope(env) {
    if (env.type === 'connected') {
      appendSystem('Connected as ' + env.clientId.slice(0, 8) + '…');
      return;
    }
    if (env.type !== 'webhook') return;

    const body = env.body;
    if (!body) return;

    // Claude reply
    if (body.type === 'reply') {
      appendClaude(body.text ?? JSON.stringify(body));
      return;
    }

    // Permission request from MCP channel server
    if (body.type === 'permission_request') {
      appendPermission(body);
      return;
    }

    // Regular user message echoed back — display as event
    if (typeof body === 'string') {
      appendEvent('webhook', body);
    } else {
      appendEvent(body.event ?? body.type ?? 'webhook', JSON.stringify(body, null, 2));
    }
  }

  function appendSystem(text) {
    append('system', null, text);
  }

  function appendClaude(text) {
    append('claude', 'Claude', text);
  }

  function appendEvent(label, text) {
    append('event', '⚡ ' + label, text);
  }

  function appendPermission(body) {
    const div = document.createElement('div');
    div.className = 'msg permission';

    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    const rid = body.request_id ?? '';
    bubble.innerHTML =
      '<div class="perm-header">🔐 Permission Request</div>' +
      '<div class="perm-desc">Claude wants to run <span class="perm-tool">' + esc(body.tool_name ?? '') + '</span>:</div>' +
      '<div class="perm-desc">' + esc(body.description ?? '') + '</div>' +
      (body.input_preview ? '<div class="perm-preview">' + esc(body.input_preview) + '</div>' : '') +
      '<div class="perm-actions">' +
        '<button class="btn allow" data-rid="' + esc(rid) + '">✓ Allow</button>' +
        '<button class="btn deny"  data-rid="' + esc(rid) + '">✗ Deny</button>' +
      '</div>' +
      '<div class="perm-id">ID: ' + esc(rid) + '</div>';

    bubble.querySelectorAll('.btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const verdict = btn.classList.contains('allow') ? 'yes' : 'no';
        postMessage(verdict + ' ' + btn.dataset.rid);
        bubble.querySelectorAll('.btn').forEach(b => b.disabled = true);
        bubble.querySelector('.perm-id').textContent = 'Verdict sent: ' + verdict;
      });
    });

    const label = document.createElement('span');
    label.className = 'label yellow';
    label.textContent = 'permission';

    div.append(label, bubble);
    msgList.appendChild(div);
    scrollBottom();
  }

  function append(cls, labelText, text) {
    const div = document.createElement('div');
    div.className = 'msg ' + cls;

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;

    div.appendChild(bubble);

    if (labelText) {
      const label = document.createElement('span');
      label.className = 'label' + (cls === 'claude' ? ' blue' : cls === 'me' ? '' : '');
      label.textContent = labelText;
      if (cls === 'me') div.prepend(label);
      else div.prepend(label);
    }

    msgList.appendChild(div);
    scrollBottom();
  }

  function scrollBottom() {
    msgList.scrollTop = msgList.scrollHeight;
  }

  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Sending ───────────────────────────────────────────────────────────────
  async function postMessage(text) {
    await fetch('/webhook?room=' + encodeURIComponent(ROOM), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(text),
    });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.style.height = '';
    append('me', 'You', text);
    await postMessage(text);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.dispatchEvent(new Event('submit'));
    }
  });

  input.addEventListener('input', () => {
    input.style.height = '';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });

  appendSystem('Connecting to room "' + ROOM + '"…');
  connect();
})();
</script>
</body>
</html>`;

    return new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}
