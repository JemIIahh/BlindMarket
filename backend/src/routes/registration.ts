import { Router } from 'express';
import { randomBytes } from 'crypto';
import { ethers } from 'ethers';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { redis } from '../services/redis.js';
import type { ApiResponse } from '../types.js';

export const registrationRouter = Router();

interface RegSession {
  token: string;
  agentName: string;
  agentWallet: string;
  agentPublicKey: string;
  status: 'pending' | 'confirmed';
  ownerAddress?: string;
  apiKey?: string;
}

const SESSION_TTL_S = 10 * 60; // 10 minutes
const key = (token: string) => `reg:session:${token}`;

async function getSession(token: string): Promise<RegSession | null> {
  const raw = await redis.get(key(token));
  return raw ? JSON.parse(raw) : null;
}

async function saveSession(session: RegSession, ttl = SESSION_TTL_S): Promise<void> {
  await redis.set(key(session.token), JSON.stringify(session), 'EX', ttl);
}

/**
 * POST /api/v1/registration/session
 * CLI calls this to start a device-flow registration.
 * Returns a token + magic link URL for the user to open.
 */
registrationRouter.post('/session', async (req, res) => {
  const { agentName, agentWallet, agentPublicKey } = req.body as {
    agentName?: string; agentWallet?: string; agentPublicKey?: string;
  };
  if (!agentName || !agentWallet || !agentPublicKey) {
    res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'agentName, agentWallet, agentPublicKey required' } });
    return;
  }
  const token = randomBytes(24).toString('hex');
  await saveSession({ token, agentName, agentWallet, agentPublicKey, status: 'pending' });
  const frontendUrl = process.env.FRONTEND_URL ?? config.corsOrigin[0] ?? 'https://www.blindmarket.xyz';
  const url = `${frontendUrl}/register/${token}`;
  res.json({ success: true, data: { token, url } } satisfies ApiResponse);
});

/**
 * GET /api/v1/registration/session/:token
 * CLI polls this to check if the user has confirmed.
 */
registrationRouter.get('/session/:token', async (req, res) => {
  const session = await getSession(req.params.token);
  if (!session) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Session not found or expired' } });
    return;
  }
  res.json({ success: true, data: { status: session.status, apiKey: session.apiKey, agentName: session.agentName, agentWallet: session.agentWallet } } satisfies ApiResponse);
});

/**
 * POST /api/v1/registration/confirm/:token
 * Frontend calls this after user signs with their wallet.
 */
registrationRouter.post('/confirm/:token', async (req, res) => {
  const session = await getSession(req.params.token);
  if (!session || session.status !== 'pending') {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Session not found or already used' } });
    return;
  }
  const { ownerAddress, signature } = req.body as { ownerAddress?: string; signature?: string };
  if (!ownerAddress || !signature) {
    res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'ownerAddress and signature required' } });
    return;
  }
  const message = `Register agent "${session.agentName}" (${session.agentWallet}) to BlindMarket.\n\nToken: ${session.token}`;
  const recovered = ethers.verifyMessage(message, signature).toLowerCase();
  if (recovered !== ownerAddress.toLowerCase()) {
    res.status(401).json({ success: false, error: { code: 'INVALID_SIGNATURE', message: 'Signature does not match address' } });
    return;
  }
  const apiKey = jwt.sign(
    { address: session.agentWallet, ownerAddress: ownerAddress.toLowerCase(), agentName: session.agentName },
    config.jwtSecret,
    { algorithm: 'HS256', expiresIn: '365d' } as jwt.SignOptions,
  );
  await saveSession({ ...session, status: 'confirmed', ownerAddress: ownerAddress.toLowerCase(), apiKey }, SESSION_TTL_S);
  res.json({ success: true, data: { apiKey, agentWallet: session.agentWallet } } satisfies ApiResponse);
});
