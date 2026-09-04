/**
 * Gas sponsorship relay endpoint.
 *
 * Privy "user_pays" mode requires sponsor_options which the React client SDK
 * doesn't support. This endpoint relays via the @privy-io/node server SDK.
 *
 * Flow:
 *   1. Frontend sends { walletAddress, to, data, value?, chain? }
 *   2. Server looks up wallet by address → gets Privy wallet ID
 *   3. Server calls wallets().ethereum().sendTransaction() with sponsor_options
 *   4. Returns { hash } (may be empty string until userop confirms)
 */
import { Router } from 'express';
import { PrivyClient } from '@privy-io/node';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { config } from '../config.js';
import { AppError } from '../middleware/errorHandler.js';

export const txRouter = Router();

const CHAIN_CAIP2: Record<string, string> = {
  base: 'eip155:8453',
  'base-mainnet': 'eip155:8453',
  'base-sepolia': 'eip155:84532',
};

function getPrivyClient(): PrivyClient {
  if (!config.privyAppId || !config.privyAppSecret) {
    throw new AppError(500, 'MISCONFIGURED', 'PRIVY_APP_ID or PRIVY_APP_SECRET not set');
  }
  return new PrivyClient({ appId: config.privyAppId, appSecret: config.privyAppSecret });
}

const relaySchema = z.object({
  walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  to: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  data: z.string().regex(/^0x[0-9a-fA-F]*$/),
  value: z.string().optional(),
  chain: z.string().default('base'),
  asset: z.string().default('usdc'),
});

txRouter.post('/relay-tx', requireAuth, async (req, res, next) => {
  try {
    const body = relaySchema.parse(req.body);
    const caip2 = CHAIN_CAIP2[body.chain];
    if (!caip2) {
      throw new AppError(400, 'INVALID_CHAIN', `Unsupported chain "${body.chain}". Supported: ${Object.keys(CHAIN_CAIP2).join(', ')}`);
    }

    const privy = getPrivyClient();

    console.log(`[relay-tx] Looking up wallet address=${body.walletAddress} chain=${body.chain} caip2=${caip2}`);

    // Look up the Privy wallet ID by address.
    // External wallets (MetaMask connected via Privy's "wallet" login) are
    // NOT managed by Privy — getWalletByAddress only finds embedded wallets
    // created by Privy's social/email login.  When the lookup fails, tell
    // the frontend to fall back to direct signing (user pays gas).
    let walletId: string;
    try {
      const wallet = await privy.wallets().getWalletByAddress({ address: body.walletAddress });
      walletId = wallet.id;
      console.log(`[relay-tx] Found wallet id=${walletId}`);
    } catch (err: any) {
      console.warn('[relay-tx] getWalletByAddress failed:', err?.status, err?.message || err);
      throw new AppError(400, 'WALLET_NOT_FOUND', `Wallet ${body.walletAddress} is not a Privy embedded wallet. Log in with email/social to create one, or the frontend will sign directly (user pays gas).`);
    }

    // Build the transaction params
    const transaction: Record<string, unknown> = {
      to: body.to,
      data: body.data,
    };
    if (body.value) {
      transaction.value = BigInt(body.value);
    }

    console.log(`[relay-tx] wallet=${body.walletAddress} id=${walletId} chain=${body.chain} caip2=${caip2} to=${body.to} asset=${body.asset}`);

    const result = await privy.wallets().ethereum().sendTransaction(walletId, {
      caip2,
      params: { transaction },
      sponsor: true,
      sponsor_options: { asset: body.asset },
    });

    const hash = result?.hash || '';
    console.log(`[relay-tx] success hash=${hash}`);

    res.json({ success: true, data: { hash, userOperationHash: result?.user_operation_hash || null } });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors.map(e => e.message).join(', ')));
    }

    const status = err?.status || err?.httpStatus;
    const msg = err?.message || err?.error?.message || String(err);

    if (msg.includes('insufficient')) {
      return next(new AppError(402, 'INSUFFICIENT_BALANCE', 'Insufficient USDC balance for gas. Please add USDC to your wallet.'));
    }
    if (msg.includes('unsupported chain') || msg.includes('not configured')) {
      return next(new AppError(400, 'UNSUPPORTED_CHAIN', 'Gas sponsorship not configured for this chain/token in Privy dashboard.'));
    }
    if (status === 401 || status === 403) {
      return next(new AppError(401, 'PRIVY_AUTH_FAILED', 'Privy server auth failed. Check PRIVY_APP_ID and PRIVY_APP_SECRET.'));
    }

    console.error('[relay-tx] Privy error:', msg.slice(0, 500));
    next(new AppError(status || 502, 'PRIVY_RELAY_FAILED', msg));
  }
});
