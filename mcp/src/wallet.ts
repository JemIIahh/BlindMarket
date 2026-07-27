import { Wallet, JsonRpcProvider, formatEther } from 'ethers';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Local signing wallet for the trust-preserving (Tier 2) flows: rent_service /
 * post_task fund escrow from THIS wallet, and briefs are encrypted locally —
 * the platform never sees plaintext or keys.
 *
 * The private key never appears in any tool output or log. Configure via:
 *   BLINDMARKET_PRIVATE_KEY  hex private key of the funding wallet
 *   BLINDMARKET_RPC_URL      optional; defaults to 0G Mainnet
 *   BLINDMARKET_CHAIN_ID     optional; defaults to 16661 (0G Mainnet)
 */

export interface WalletCtx {
  wallet: Wallet;
  provider: JsonRpcProvider;
  rpcUrl: string;
  chainId: number;
}

export const DEFAULT_RPC_URL = 'https://evmrpc.0g.ai';
export const DEFAULT_CHAIN_ID = 16661;

export function loadWallet(): WalletCtx | null {
  const pk = process.env.BLINDMARKET_PRIVATE_KEY;
  if (!pk) return null;
  const rpcUrl = process.env.BLINDMARKET_RPC_URL ?? DEFAULT_RPC_URL;
  const chainId = parseInt(process.env.BLINDMARKET_CHAIN_ID ?? String(DEFAULT_CHAIN_ID), 10);
  const provider = new JsonRpcProvider(rpcUrl, chainId);
  const wallet = new Wallet(pk.startsWith('0x') ? pk : `0x${pk}`, provider);
  return { wallet, provider, rpcUrl, chainId };
}

export function registerWalletTools(server: McpServer, ctx: WalletCtx | null): void {
  server.registerTool(
    'wallet_status',
    {
      title: 'Wallet Status',
      description: 'The local funding wallet used by rent_service/post_task: address, native 0G balance, chain. Returns not_configured if BLINDMARKET_PRIVATE_KEY is unset.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      if (!ctx) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ configured: false, hint: 'Set BLINDMARKET_PRIVATE_KEY (and optionally BLINDMARKET_RPC_URL) to enable spending tools' }),
          }],
        };
      }
      let balance: string | null = null;
      try {
        balance = formatEther(await ctx.provider.getBalance(ctx.wallet.address));
      } catch { /* RPC unreachable — report address anyway */ }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ configured: true, address: ctx.wallet.address, balance0G: balance, chainId: ctx.chainId, rpcUrl: ctx.rpcUrl }, null, 2),
        }],
      };
    },
  );
}
