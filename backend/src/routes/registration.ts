import { Router } from 'express';
import { randomBytes } from 'crypto';
import { ethers } from 'ethers';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
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
 * Canonical challenge signed by the agent wallet at `/session` open, proving
 * control of `agentWallet` before a session is created for it. Exported so
 * `cli/` and this file's own tests use the identical string — a mismatch
 * here silently breaks registration. `sdk/` duplicates this (it cannot
 * import from the backend); keep both in sync with this definition.
 */
export function agentRegistrationMessage(agentName: string, agentWallet: string, agentPublicKey: string): string {
  return `BlindMarket agent registration\nname: ${agentName}\nwallet: ${agentWallet.toLowerCase()}\npubkey: ${agentPublicKey.toLowerCase()}`;
}

const SessionSchema = z.object({
  agentName: z.string().min(1),
  agentWallet: z.string().min(1),
  agentPublicKey: z.string().min(1),
  agentSignature: z.string().min(1),
});

/**
 * POST /api/v1/registration/session
 * CLI calls this to start a device-flow registration.
 * Returns a token + magic link URL for the user to open.
 */
registrationRouter.post('/session', async (req, res, next) => {
  if (!config.registrationEnabled) {
    // Gated while registration hardening lands.
    res.status(503).json({ success: false, error: { code: 'REGISTRATION_DISABLED', message: 'Agent registration is temporarily unavailable' } });
    return;
  }
  let body: z.infer<typeof SessionSchema>;
  try {
    body = SessionSchema.parse(req.body);
  } catch (err: any) {
    if (err?.name === 'ZodError') {
      res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: err.errors?.[0]?.message || 'Invalid input' } });
      return;
    }
    next(err);
    return;
  }
  const { agentName, agentWallet, agentPublicKey, agentSignature } = body;

  // Proves the caller controls agentWallet before a session is opened for it.
  let recoveredAgent: string;
  try {
    recoveredAgent = ethers.verifyMessage(
      agentRegistrationMessage(agentName, agentWallet, agentPublicKey),
      agentSignature,
    ).toLowerCase();
  } catch {
    res.status(401).json({ success: false, error: { code: 'INVALID_AGENT_SIGNATURE', message: 'agentSignature must be signed by agentWallet' } });
    return;
  }
  if (recoveredAgent !== agentWallet.toLowerCase()) {
    res.status(401).json({ success: false, error: { code: 'INVALID_AGENT_SIGNATURE', message: 'agentSignature must be signed by agentWallet' } });
    return;
  }

  // Closes a pubkey-substitution variant: an attacker who controls agentWallet
  // still can't register it against someone else's encryption pubkey.
  let derived: string;
  try {
    derived = ethers.computeAddress('0x' + agentPublicKey.replace(/^0x/, '')).toLowerCase();
  } catch {
    res.status(400).json({ success: false, error: { code: 'PUBKEY_MISMATCH', message: 'agentPublicKey does not derive to agentWallet' } });
    return;
  }
  if (derived !== agentWallet.toLowerCase()) {
    res.status(400).json({ success: false, error: { code: 'PUBKEY_MISMATCH', message: 'agentPublicKey does not derive to agentWallet' } });
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
  if (!config.registrationEnabled) {
    // Gated while registration hardening lands.
    res.status(503).json({ success: false, error: { code: 'REGISTRATION_DISABLED', message: 'Agent registration is temporarily unavailable' } });
    return;
  }
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
    {
      address: session.agentWallet,
      ownerAddress: ownerAddress.toLowerCase(),
      agentName: session.agentName,
      // Marks this JWT as agent-registration-issued so requireFounder can
      // reject it regardless of the address claim it carries.
      typ: 'agent-registration',
    },
    config.jwtSecret,
    { algorithm: 'HS256', expiresIn: '365d' } as jwt.SignOptions,
  );
  await saveSession({ ...session, status: 'confirmed', ownerAddress: ownerAddress.toLowerCase(), apiKey }, SESSION_TTL_S);
  res.json({ success: true, data: { apiKey, agentWallet: session.agentWallet } } satisfies ApiResponse);
});
