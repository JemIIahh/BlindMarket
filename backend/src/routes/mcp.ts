import { Router } from 'express';
import type { Response } from 'express';
import cors from 'cors';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireAuth } from '../middleware/auth.js';
import type { AuthRequest } from '../types.js';
import { buildMcpServer } from '../services/mcp/tools.js';

/**
 * Remote MCP endpoint (Streamable HTTP, stateless mode).
 *
 * POST /mcp with an sk_ API key ("Authorization: Bearer sk_…" or "X-API-Key")
 * exposes the Tier-1 tool surface (services/mcp/tools.ts) to any MCP-capable
 * harness: Claude Code (`claude mcp add --transport http`), Claude/ChatGPT
 * custom connectors, Hermes Agent, Cursor, MCP Inspector, etc.
 *
 * Stateless by design: a fresh McpServer + transport per POST, no session
 * store, JSON responses (no SSE). That makes the endpoint indifferent to
 * restarts/scale-out on Render and keeps the surface pure request/response —
 * the tool set has no server-initiated streams.
 */

export const mcpRouter = Router();

// MCP clients are not browsers, but the MCP Inspector and web-embedded clients
// are — they need permissive CORS on exactly this route (the app-wide CORS
// allowlist stays restrictive for everything else).
mcpRouter.use(cors({
  origin: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'Mcp-Session-Id', 'MCP-Protocol-Version', 'Last-Event-ID'],
  exposedHeaders: ['Mcp-Session-Id', 'WWW-Authenticate'],
}));

function unauthorized(res: Response): void {
  // WWW-Authenticate is required by the MCP auth spec so clients know how to
  // proceed; the resource-metadata OAuth discovery URL lands here in the
  // (deferred) OAuth phase.
  res.status(401)
    .set('WWW-Authenticate', 'Bearer realm="BlindMarket MCP"')
    .json({
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message: 'Unauthorized — pass a BlindMarket API key via "Authorization: Bearer sk_…" or "X-API-Key: sk_…". Mint one in the web app under Settings → API keys.',
      },
      id: null,
    });
}

async function handleMcp(req: AuthRequest, res: Response): Promise<void> {
  try {
    const server = buildMcpServer(req.user!);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    // express.json() has already consumed the stream — hand the parsed body over.
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[mcp] request failed:', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
}

mcpRouter.post('/', (req, res) => {
  // requireAuth is driven manually (not as route middleware) so an auth
  // failure can produce the MCP-shaped 401 + WWW-Authenticate instead of the
  // REST error envelope. It throws synchronously on a missing credential and
  // calls next(err) on an invalid one — cover both.
  try {
    requireAuth(req as AuthRequest, res, (err?: unknown) => {
      if (err) {
        unauthorized(res);
        return;
      }
      void handleMcp(req as AuthRequest, res);
    });
  } catch {
    unauthorized(res);
  }
});

// Stateless mode: no server-initiated SSE stream to GET, no session to DELETE.
function methodNotAllowed(_req: unknown, res: Response): void {
  res.status(405).set('Allow', 'POST').json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed — this MCP endpoint is stateless; use POST' },
    id: null,
  });
}
mcpRouter.get('/', methodNotAllowed);
mcpRouter.delete('/', methodNotAllowed);
