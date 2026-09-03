/**
 * Gas sponsorship relay endpoint.
 *
 * Privy "user_pays" mode requires `sponsor_options` which the React SDK
 * doesn't support yet. This endpoint relays the tx through the backend,
 * adding the required `sponsor_options` to Privy's REST API.
 *
 * Flow:
 *   1. Frontend builds the Privy RPC body and signs it via useAuthorizationSignature
 *   2. Frontend sends the signed request to this endpoint
 *   3. This endpoint forwards to Privy's REST API with the authorization signature
 *   4. Returns the tx hash
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import type { AuthRequest } from '../types.js';
import { config } from '../config.js';
import { AppError } from '../middleware/errorHandler.js';

export const txRouter = Router();

const sendSponsoredSchema = z.object({
  to: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Invalid to address'),
  data: z.string().regex(/^0x[0-9a-fA-F]*$/, 'Invalid data').optional(),
  value: z.string().optional(),
  chainId: z.number().int(),
  walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  authorizationSignature: z.string(),
  // The full Privy RPC request body constructed and signed by the frontend
  privyRpcBody: z.object({
    method: z.literal('eth_sendTransaction'),
    caip2: z.string(),
    chain_type: z.literal('ethereum'),
    sponsor: z.literal(true),
    sponsor_options: z.object({ asset: z.literal('usdc') }),
    params: z.object({
      transaction: z.record(z.string()),
    }),
  }),
});

/**
 * POST /api/v1/tx/send-sponsored
 *
 * Forwards the signed Privy RPC request to Privy's REST API with the
 * authorization signature header.
 */
txRouter.post('/send-sponsored', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    if (!config.privyAppSecret) {
      throw new AppError(500, 'MISCONFIGURED', 'PRIVY_APP_SECRET not set — gas sponsorship relay disabled');
    }

    const data = sendSponsoredSchema.parse(req.body);

    // Forward to Privy REST API
    const privyRpcUrl = `https://api.privy.io/v1/wallets/${data.walletAddress}/rpc`;
    const authHeader = Buffer.from(`${config.privyAppId}:${config.privyAppSecret}`).toString('base64');

    const privyRes = await fetch(privyRpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${authHeader}`,
        'privy-app-id': config.privyAppId,
        'privy-authorization-signature': data.authorizationSignature,
      },
      body: JSON.stringify(data.privyRpcBody),
    });

    const privyBody = await privyRes.json();

    if (!privyRes.ok) {
      console.error('[tx/send-sponsored] Privy API error:', privyRes.status, JSON.stringify(privyBody).slice(0, 500));
      const errMsg = privyBody?.['message'] || privyBody?.error || `Privy API ${privyRes.status}`;
      throw new AppError(privyRes.status >= 400 && privyRes.status < 500 ? 400 : 502, 'PRIVY_RELAY_FAILED', errMsg);
    }

    const txHash = privyBody?.data?.hash || privyBody?.hash || null;
    console.log(`[tx/send-sponsored] relayed tx hash=${txHash} chain=${data.privyRpcBody.caip2}`);

    res.json({ success: true, data: { hash: txHash } });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors.map(e => e.message).join(', ')));
    }
    next(err);
  }
});
