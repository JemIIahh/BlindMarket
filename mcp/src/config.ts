export interface McpConfig {
  apiKey: string;
  apiBase?: string;
  /** False when no API key was supplied. The server still starts; tools that
   *  need credentials fail per-call with a message the user can actually see. */
  authenticated: boolean;
}

/**
 * Load config WITHOUT exiting when the API key is missing.
 *
 * This used to `process.exit(1)` on a missing BLINDMARKET_API_KEY. MCP clients
 * launch the server over stdio with a bare environment and do not surface its
 * stderr, so the user saw only "CONNECTION_CLOSED: Connection closed" with no
 * indication that a key was needed — verified against a real `claude mcp add`,
 * which reported exactly that.
 *
 * Exiting is also wrong on the merits: an MCP server should complete the
 * handshake so the client can list its tools, and several of ours (health,
 * stats, list_open_tasks, browse_a2a_tasks) need no credentials at all. An
 * auth failure belongs at the call that needs auth, where the message reaches
 * the user, not at startup where it reaches nobody.
 */
export function loadConfig(): McpConfig {
  const apiKey = process.env.BLINDMARKET_API_KEY;
  if (!apiKey) {
    console.error(
      '[blindmarket-mcp] No BLINDMARKET_API_KEY set — starting in unauthenticated mode. ' +
      'Public tools (health, stats, list_open_tasks, browse_a2a_tasks) work; ' +
      'anything account-scoped will return an error asking for a key. ' +
      'Mint one in the web app under Settings -> API keys.',
    );
  }
  return {
    apiKey: apiKey ?? '',
    apiBase: process.env.BLINDMARKET_API_BASE ?? 'https://api.blindmarket.xyz',
    authenticated: !!apiKey,
  };
}
