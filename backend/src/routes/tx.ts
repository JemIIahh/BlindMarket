/**
 * Gas sponsorship relay endpoint.
 *
 * Privy "user_pays" mode requires sponsor_options which the React client SDK
 * doesn't support. This endpoint relays via the @privy-io/node server SDK.
 *
 * Flow:
 *   1. Frontend sends { walletAddress, to, data, value?, chain? }
 *   2. Server looks up wallet by address → gets Privy wallet ID
 *   3. Server generates authorization signature from user's Privy JWT
 *   4. Server calls wallets().ethereum().sendTransaction() with sponsor_options
 *   5. Returns { hash }
 */
import { Router } from 'express';
import { PrivyClient, generateAuthorizationSignatures } from '@privy-io/node';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import type { AuthRequest, AuthUser } from '../types.js';
import { config } from '../config.js';
import { AppError } from '../middleware/errorHandler.js';

/** Privy eth_sendTransaction RPC response — fields not in WalletRpcResponse. */
interface PrivySendTxResult {
  hash?: string;
  user_operation_hash?: string;
  transaction_id?: string;
  sponsorship_provider?: string;
  caip2?: string;
}

export const txRouter = Router();

const CHAIN_CAIP2: Record<string, string> = {
  base: 'eip155:8453',
  'base-mainnet': 'eip155:8453',
  'base-sepolia': 'eip155:84532',
};

let privyClient: PrivyClient | null = null;
function getPrivyClient(): PrivyClient {
  if (!privyClient) {
    if (!config.privyAppId || !config.privyAppSecret) {
      throw new AppError(500, 'MISCONFIGURED', 'PRIVY_APP_ID or PRIVY_APP_SECRET not set');
    }
    privyClient = new PrivyClient({ appId: config.privyAppId, appSecret: config.privyAppSecret });
  }
  return privyClient;
}

const relaySchema = z.object({
  walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  to: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  data: z.string().regex(/^0x[0-9a-fA-F]*$/),
  value: z.string().optional(),
  chain: z.string().default('base'),
  asset: z.string().default('usdc'),
});

/**
 * The Privy wallets this principal is entitled to move funds from.
 *
 * `ownerAddress` is deliberately EXCLUDED. It is set on agent platform tokens
 * and names the human who owns the agent — and agent private keys live in
 * plaintext in Postgres, so honouring it would turn any agent-key compromise
 * into a compromise of that owner's personal wallet. An agent has its own
 * wallet and does not relay from its owner's.
 */
function callerWallets(user: AuthUser | undefined): Set<string> {
  if (!user) return new Set();
  return new Set(
    [user.address, ...(user.addresses ?? [])]
      .filter((a): a is string => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a))
      .map((a) => a.toLowerCase()),
  );
}

txRouter.post('/relay-tx', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const body = relaySchema.parse(req.body);

    // The wallet must belong to the caller.
    //
    // This endpoint hands the platform's PRIVY_AUTHORIZATION_KEY an arbitrary
    // `to` + `data` and signs it from the wallet named in the BODY, with gas
    // sponsored. requireAuth proves the caller is *someone*; until this check
    // nothing proved the wallet was theirs, so any authenticated principal
    // could have the platform sign `transfer(attacker, balance)` out of a
    // victim's embedded wallet and pay the gas for it. Reproduced before
    // fixing: that request returned 200.
    //
    // The check runs FIRST, before the Privy lookup, so an unauthorised caller
    // cannot even probe which addresses are embedded wallets.
    if (!callerWallets(req.user).has(body.walletAddress.toLowerCase())) {
      throw new AppError(
        403,
        'NOT_WALLET_OWNER',
        'This wallet is not linked to your account. You can only relay transactions from your own embedded wallet.',
      );
    }

    const caip2 = CHAIN_CAIP2[body.chain];
    if (!caip2) {
      throw new AppError(400, 'INVALID_CHAIN', `Unsupported chain "${body.chain}". Supported: ${Object.keys(CHAIN_CAIP2).join(', ')}`);
    }

    const privy = getPrivyClient();

    console.log(`[relay-tx] Looking up wallet address=${body.walletAddress} chain=${body.chain} caip2=${caip2}`);

    // Look up the Privy wallet ID by address.
    let walletId: string;
    try {
      const wallet = await privy.wallets().getWalletByAddress({ address: body.walletAddress });
      walletId = wallet.id;
      console.log(`[relay-tx] Found wallet id=${walletId}`);
    } catch (err: any) {
      console.warn('[relay-tx] getWalletByAddress failed:', JSON.stringify({ status: err?.status, message: err?.message, body: err?.body || err?.error }, null, 2));
      throw new AppError(400, 'WALLET_NOT_FOUND', `Wallet ${body.walletAddress} is not a Privy embedded wallet. Log in with email/social to create one.`);
    }

    // Build the transaction params
    const transaction: Record<string, unknown> = {
      to: body.to,
      data: body.data,
    };
    if (body.value) {
      transaction.value = `0x${BigInt(body.value).toString(16)}`;
    }

    console.log(`[relay-tx] wallet=${body.walletAddress} id=${walletId} chain=${body.chain} caip2=${caip2} to=${body.to} asset=${body.asset}`);

    // Generate authorization signature using the server-side authorization key.
    // This key must be added as a signer on the user's wallet in the Privy dashboard.
    if (!config.privyAuthorizationKey) {
      throw new AppError(500, 'MISCONFIGURED', 'PRIVY_AUTHORIZATION_KEY not set in backend config');
    }

    const rpcBody: Record<string, unknown> = {
      method: 'eth_sendTransaction' as const,
      caip2,
      chain_type: 'ethereum' as const,
      params: { transaction },
      sponsor: true,
      sponsor_options: { asset: body.asset },
    };
    const rpcUrl = `https://api.privy.io/v1/wallets/${walletId}/rpc`;

    const signatures = await generateAuthorizationSignatures(privy, {
      authorizationContext: { authorization_private_keys: [config.privyAuthorizationKey] },
      input: {
        version: 1,
        method: 'POST',
        url: rpcUrl,
        body: rpcBody,
        headers: { 'privy-app-id': config.privyAppId! },
      },
    });

    const authSignature = signatures[0];
    if (!authSignature) {
      throw new AppError(500, 'SIGN_FAILED', 'Failed to generate authorization signature');
    }

    console.log(`[relay-tx] Authorization signature generated, sending transaction...`);

    const rpcInput = {
      method: 'eth_sendTransaction' as const,
      caip2,
      chain_type: 'ethereum' as const,
      params: { transaction },
      sponsor: true,
      sponsor_options: { asset: body.asset },
    };

    const result = await privy.wallets()._rpc(walletId, rpcInput as any, {
      headers: { 'privy-authorization-signature': authSignature },
    });

    const rpcResult = (result as any)?.data as PrivySendTxResult | undefined || result as unknown as PrivySendTxResult;
    const userOpHash = rpcResult.user_operation_hash || '';
    const txId = rpcResult.transaction_id || null;
    console.log(`[relay-tx] userOpHash=${userOpHash} txId=${txId} raw=${JSON.stringify(result).slice(0, 300)}`);

    const finalHash = rpcResult.hash || '';
    const isUserOp = !rpcResult.hash && !!userOpHash;
    console.log(`[relay-tx] finalHash=${finalHash || '(user-op, no tx hash yet)'} isUserOp=${isUserOp}`);

    res.json({ success: true, data: { hash: finalHash || userOpHash, isUserOp, userOperationHash: userOpHash || null, transactionId: txId } });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors.map(e => e.message).join(', ')));
    }

    // Deliberate AppErrors raised by this handler are already the answer we
    // want the caller to get — pass them straight through. Without this they
    // fall into the Privy-error branch below and are relabelled 502
    // UPSTREAM_ERROR: the 403 ownership refusal reported as a Privy outage,
    // and the pre-existing WALLET_NOT_FOUND (400) and MISCONFIGURED (500)
    // likewise. Same shape as the auth-middleware bug where a 401 thrown
    // inside a .then() was rewrapped as a 500.
    if (err instanceof AppError) {
      return next(err);
    }

    const status = err?.status || err?.httpStatus;
    const msg = err?.message || err?.error?.message || String(err);
    console.log(`[relay-tx] Full error:`, JSON.stringify({ status, message: msg, body: err?.error || err?.body || err?.response || null, stack: err?.stack?.slice(0, 300) }, null, 2));

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
