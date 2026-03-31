import { WebSocketProxy } from './durable-object';

export { WebSocketProxy };

export interface Env {
  WEBSOCKET_PROXY: DurableObjectNamespace;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Webhook-Source',
};

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Health check (handled at Worker level, no DO needed)
    if (url.pathname === '/health') {
      return Response.json(
        { status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' },
        { headers: CORS_HEADERS }
      );
    }

    // Route to Durable Object
    // Support optional ?room=<name> param for multi-room usage
    const room = url.searchParams.get('room') || 'default';
    const id = env.WEBSOCKET_PROXY.idFromName(room);
    const stub = env.WEBSOCKET_PROXY.get(id);

    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;
