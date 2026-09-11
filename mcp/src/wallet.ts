import { Wallet, JsonRpcProvider, formatEther } from 'ethers';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Settlement } from './settlement.js';

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

import { derivePublicKeyHex } from './crypto.js';

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

/** `settlement` is the resolver rent.ts builds — how spends are paid for. It
 *  is reported here because "is a private key set" stopped being the whole
 *  answer once Base landed: on Base nothing signs locally, so a missing key
 *  is fine and the thing to show is the relay wallet instead. */
export function registerWalletTools(
  server: McpServer,
  ctx: WalletCtx | null,
  settlement?: () => Promise<Settlement>,
): void {
  server.registerTool(
    'wallet_status',
    {
      title: 'Wallet Status',
      description: 'How rent_service/post_task/cancel_task/claim_timeout pay: the settlement chain the backend is in (Base USDC via the gas-sponsored relay, or native 0G from the local wallet), the wallet that pays, and its balance. The local wallet section is not_configured if BLINDMARKET_PRIVATE_KEY is unset — that only matters for 0G.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const localWallet: Record<string, unknown> = ctx
        ? {
            configured: true, address: ctx.wallet.address, chainId: ctx.chainId, rpcUrl: ctx.rpcUrl,
            // What to pass as `publicKey` to register_as_executor. Posters ECIES-wrap
            // the brief key to it, and fetch_brief decrypts with the matching
            // private key — so an executor that registers any OTHER pubkey can
            // accept a private task and never open it.
            executorPublicKey: derivePublicKeyHex(ctx.wallet.privateKey),
          }
        : { configured: false, hint: 'Set BLINDMARKET_PRIVATE_KEY (and optionally BLINDMARKET_RPC_URL) to spend on 0G. Not needed when the backend settles on Base.' };
      if (ctx) {
        try {
          localWallet.balance0G = formatEther(await ctx.provider.getBalance(ctx.wallet.address));
        } catch { /* RPC unreachable — report address anyway */ }
      }

      let settlementReport: Record<string, unknown>;
      if (!settlement) {
        settlementReport = { mode: 'unknown' };
      } else {
        try {
          const s = await settlement();
          settlementReport = s.mode === 'base'
            ? { mode: 'base', chainId: s.chainId, escrowAddress: s.escrowAddress, usdcAddress: s.usdcAddress, relayChain: s.relayChain, payFrom: s.payFrom, signs: 'backend relay (Privy) — no local key involved. Gas: sponsored in USDC where Privy sponsorship is enabled for this chain, otherwise from payFrom\'s own native balance' }
            : { mode: '0g', payFrom: ctx?.wallet.address ?? null, signs: ctx ? 'local wallet' : 'NOTHING — set BLINDMARKET_PRIVATE_KEY' };
        } catch (err) {
          settlementReport = { mode: 'unknown', error: (err as Error).message };
        }
      }

      return {
        content: [{
          type: 'text' as const,
          // `configured` kept at top level for existing readers of this tool.
          text: JSON.stringify({ configured: !!ctx, ...localWallet, settlement: settlementReport }, null, 2),
        }],
      };
    },
  );
}
