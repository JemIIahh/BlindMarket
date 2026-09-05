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
import { config } from '../config.js';
import { AppError } from '../middleware/errorHandler.js';

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

    const rpcResult = result?.data || result || {};
    const userOpHash = rpcResult.user_operation_hash || '';
    const txId = rpcResult.transaction_id || null;
    console.log(`[relay-tx] userOpHash=${userOpHash} txId=${txId} raw=${JSON.stringify(result).slice(0, 300)}`);

    // Wait for the user-op to be included on-chain and get the real tx hash.
    // The bundler takes 1-3 blocks (~3-9s on Base). We poll
    // eth_getUserOperationReceipt via Privy's RPC.
    let finalHash = rpcResult.hash || '';
    let receipt = null;
    if (userOpHash && !finalHash) {
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 3000));
        try {
          const opReceipt = await privy.wallets()._rpc(walletId, {
            method: 'eth_getUserOperationReceipt',
            params: [userOpHash],
            caip2,
            chain_type: 'ethereum' as const,
          } as any);
          const rData = (opReceipt as any)?.data || opReceipt || {};
          if (rData.transactionHash) {
            finalHash = rData.transactionHash;
            receipt = rData;
            console.log(`[relay-tx] user-op included at block ${rData.blockNumber} txHash=${finalHash}`);
            break;
          }
        } catch {
          // eth_getUserOperationReceipt may not be supported — fall through
          console.log(`[relay-tx] poll ${i + 1}: no receipt yet`);
        }
      }
      // Fallback: if we couldn't get txHash from UserOp receipt,
      // use the userOpHash itself — backend /tasks/index will retry.
      if (!finalHash) {
        finalHash = userOpHash;
        console.log(`[relay-tx] fallback: using userOpHash as txHash`);
      }
    }

    res.json({ success: true, data: { hash: finalHash, userOperationHash: userOpHash || null, transactionId: txId } });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors.map(e => e.message).join(', ')));
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
