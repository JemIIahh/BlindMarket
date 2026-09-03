/**
 * Gas sponsorship relay endpoint.
 *
 * Privy "user_pays" mode requires sponsor_options which the React SDK
 * doesn't support. This endpoint relays the request to Privy's server-side API.
 *
 * The frontend signs the request via useAuthorizationSignature and sends
 * the raw body + signature. This endpoint adds Basic auth and forwards.
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import type { AuthRequest } from '../types.js';
import { config } from '../config.js';
import { AppError } from '../middleware/errorHandler.js';

export const txRouter = Router();

const sendSponsoredSchema = z.object({
  walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  authorizationSignature: z.string(),
  privyRpcBody: z.record(z.unknown()),
  expiryMs: z.string(),
});

txRouter.post('/send-sponsored', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    if (!config.privyAppSecret) {
      throw new AppError(500, 'MISCONFIGURED', 'PRIVY_APP_SECRET not set');
    }

    const { walletAddress, authorizationSignature, privyRpcBody, expiryMs } = sendSponsoredSchema.parse(req.body);

    const privyRpcUrl = `https://api.privy.io/v1/wallets/${walletAddress}/rpc`;
    const authHeader = Buffer.from(`${config.privyAppId}:${config.privyAppSecret}`).toString('base64');

    console.log(`[tx/send-sponsored] relaying to Privy wallet=${walletAddress} method=${privyRpcBody.method} expiry=${expiryMs}`);

    const privyRes = await fetch(privyRpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${authHeader}`,
        'privy-app-id': config.privyAppId,
        'privy-authorization-signature': authorizationSignature,
        'privy-request-expiry': expiryMs,
      },
      body: JSON.stringify(privyRpcBody),
      signal: AbortSignal.timeout(30_000),
    });

    const privyBody = await privyRes.json();

    if (!privyRes.ok) {
      console.error('[tx/send-sponsored] Privy error:', privyRes.status, JSON.stringify(privyBody).slice(0, 500));
      const errMsg = privyBody?.message || privyBody?.error || `Privy API ${privyRes.status}`;
      throw new AppError(privyRes.status >= 400 && privyRes.status < 500 ? 400 : 502, 'PRIVY_RELAY_FAILED', errMsg);
    }

    const txHash = privyBody?.data?.hash || privyBody?.hash || null;
    console.log(`[tx/send-sponsored] success hash=${txHash}`);

    res.json({ success: true, data: { hash: txHash } });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors.map(e => e.message).join(', ')));
    }
    if (err.name === 'TimeoutError') {
      return next(new AppError(504, 'PRIVY_TIMEOUT', 'Privy API request timed out'));
    }
    next(err);
  }
});
