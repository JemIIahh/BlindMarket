import { config } from '../config.js';

/**
 * Pimlico bundler endpoint per CCTP chain. The API key is project-wide; only
 * the URL slug varies per chain. An explicitly configured PIMLICO_BUNDLER_URL
 * keeps meaning base-sepolia (the workers' existing contract); every other
 * chain derives its URL from the slug table. The key never leaves the
 * backend — browsers submit UserOps through POST /cctp/userop, which
 * validates and forwards here.
 */

// Pimlico v2 URL slugs. Testnet ones are verified live (a wrong slug fails
// loudly at estimate time with "chain X is not supported"); mainnet slugs
// are the documented names but untested — no mainnet paymaster exists yet,
// so nothing reads them.
const SLUGS: Record<string, string> = {
  'base-sepolia': 'base-sepolia',
  'base': 'base',
  'ethereum-sepolia': 'sepolia',
  'ethereum': 'ethereum',
  'arbitrum-sepolia': 'arbitrum-sepolia',
  'arbitrum': 'arbitrum-one',
  'optimism-sepolia': 'optimism-sepolia',
  'polygon-amoy': 'polygon-amoy',
  'polygon': 'polygon',
};

export function pimlicoUrl(chainKey: string): string | null {
  if (!config.pimlicoApiKey) return null;
  if (chainKey === 'base-sepolia' && config.pimlicoBundlerUrl) return config.pimlicoBundlerUrl;
  const slug = SLUGS[chainKey];
  if (!slug) return null;
  return `https://api.pimlico.io/v2/${slug}/rpc`;
}

export function isPimlicoConfigured(chainKey: string): boolean {
  return pimlicoUrl(chainKey) !== null;
}

interface RpcEnvelope {
  result?: unknown;
  error?: { message?: string; code?: number | string };
}

/** POST a bundler JSON-RPC method with the project key as a Bearer token. */
export async function pimlicoRpc<T>(chainKey: string, method: string, params: unknown[]): Promise<T> {
  const url = pimlicoUrl(chainKey);
  if (!url) {
    throw new Error(`No Pimlico bundler configured for chain "${chainKey}" (PIMLICO_API_KEY unset or unknown chain)`);
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.pimlicoApiKey}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  const json = (await res.json().catch(() => ({}))) as RpcEnvelope;
  if (json.error) {
    throw new Error(`Bundler ${method} failed: ${json.error.message ?? JSON.stringify(json.error)}`);
  }
  if (json.result == null) {
    throw new Error(`Bundler ${method} returned no result`);
  }
  return json.result as T;
}
