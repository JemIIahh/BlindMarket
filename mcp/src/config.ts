export interface McpConfig {
  apiKey: string;
  apiBase?: string;
}

export function loadConfig(): McpConfig {
  const apiKey = process.env.BLINDMARKET_API_KEY ?? '';
  if (!apiKey) {
    console.error('[blindmarket-mcp] BLINDMARKET_API_KEY not set — write tools will fail, read-only tools still work');
  }
  return {
    apiKey,
    apiBase: process.env.BLINDMARKET_API_BASE ?? 'https://api.blindmarket.xyz',
  };
}
