import { Router } from 'express';
import { z } from 'zod';
import { getCctpChain, isSupportedCctpChain } from '../services/cctpChains.js';
import { arcProvider, baseProvider } from '../services/chain.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { AppError } from '../middleware/errorHandler.js';

/**
 * Same-origin JSON-RPC read proxy, one path per chain:
 *   POST /api/v1/rpc/:chain  { jsonrpc: '2.0', id, method, params }
 *
 * Why it exists: privacy extensions block well-known public RPC endpoints
 * (net::ERR_BLOCKED_BY_CLIENT on rpc.testnet.arc.io), which silently breaks
 * every balance read, allowance poll and log scan in the web app — the UI
 * then shows no balance with no error. Same-origin calls are never
 * blocklisted, so the frontend points its fallback providers here.
 *
 * Strictly reads: only the methods below are forwarded, so a compromised
 * frontend (or any caller) can never sign, broadcast, or mine through it.
 * No auth (chain data is public, like /cctp/config and /cctp/quote);
 * per-IP rate limited.
 */

export const rpcRouter = Router();

const READ_METHODS: ReadonlySet<string> = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_getBalance',
  'eth_getCode',
  'eth_call',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_getBlockByNumber',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getLogs',
  'net_version',
]);

const RpcCallSchema = z.object({
  jsonrpc: z.literal('2.0').optional(),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().min(1),
  params: z.array(z.unknown()).optional(),
});

function providerFor(chainKey: string) {
  if (chainKey === 'arc') return arcProvider;
  if (chainKey === 'base') return baseProvider;
  if (isSupportedCctpChain(chainKey)) return getCctpChain(chainKey)?.rpc ?? null;
  return null;
}

async function handleOne(chainKey: string, body: unknown) {
  const provider = providerFor(chainKey);
  if (!provider) {
    throw new AppError(400, 'RPC_UNKNOWN_CHAIN', `No read provider for chain "${chainKey}"`);
  }
  const parsed = RpcCallSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', parsed.error.message);
  }
  const { method, params, id } = parsed.data;
  if (!READ_METHODS.has(method)) {
    throw new AppError(403, 'RPC_METHOD_FORBIDDEN', `Method ${method} is not proxied (reads only)`);
  }
  try {
    const result = await provider.send(method, params ?? []);
    return { jsonrpc: '2.0', id: id ?? 1, result };
  } catch (e) {
    return {
      jsonrpc: '2.0',
      id: id ?? 1,
      error: { code: -32000, message: `Upstream ${method} failed: ${(e as Error).message.slice(0, 200)}` },
    };
  }
}

// Reads are cheap but log scans fan out upstream: 100/min per IP leaves real
// flows (10s balance polls, 4s scan ticks) ample headroom.
const rpcLimiter = createRateLimiter();

rpcRouter.post('/:chain', rpcLimiter, async (req, res, next) => {
  try {
    const chainKey = req.params.chain;
    if (Array.isArray(req.body)) {
      if (req.body.length === 0 || req.body.length > 25) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Batch must hold 1-25 calls');
      }
      // Per-call errors envelope like upstream failures — one bad call must
      // not poison the batch. Non-AppErrors still throw batch-wide.
      res.json(
        await Promise.all(
          req.body.map(async (b) => {
            try {
              return await handleOne(chainKey, b);
            } catch (e) {
              if (e instanceof AppError) {
                const id = (b as { id?: string | number } | null)?.id ?? 1;
                return { jsonrpc: '2.0', id, error: { code: e.code, message: e.message } };
              }
              throw e;
            }
          }),
        ),
      );
      return;
    }
    res.json(await handleOne(chainKey, req.body));
  } catch (err) {
    next(err);
  }
});
