import { Router } from 'express';
import { randomBytes } from 'crypto';
import { ethers } from 'ethers';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from '../config.js';
import { redis } from '../services/redis.js';
import { disconnectSocketsForToken } from '../services/socket.js';
import { requireAuth, REVOKED_JWT_TTL_S } from '../middleware/auth.js';
import type { ApiResponse, AuthRequest } from '../types.js';

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

// Every issued registration token is recorded against its agent wallet and the
// owner who confirmed it, for as long as it can be valid, so it can be revoked
// on its own. Before, nothing recorded them and no route could map a
// revocation request to one (security audit run 1, C27).
interface IssuedToken { agentWallet: string; ownerAddress: string }
const issuedKey = (jti: string) => `reg:token:${jti}`;
const walletTokensKey = (wallet: string) => `reg:tokens:${wallet.toLowerCase()}`;

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
  const jti = randomBytes(16).toString('hex'); // M3 (audit): revocable via the auth denylist
  const apiKey = jwt.sign(
    {
      address: session.agentWallet,
      ownerAddress: ownerAddress.toLowerCase(),
      agentName: session.agentName,
      // Marks this JWT as agent-registration-issued so requireFounder can
      // reject it regardless of the address claim it carries.
      typ: 'agent-registration',
      jti,
    },
    config.jwtSecret,
    { algorithm: 'HS256', expiresIn: '365d' } as jwt.SignOptions,
  );
  const issued: IssuedToken = { agentWallet: session.agentWallet.toLowerCase(), ownerAddress: ownerAddress.toLowerCase() };
  await redis.set(issuedKey(jti), JSON.stringify(issued), 'EX', REVOKED_JWT_TTL_S);
  await redis.sadd(walletTokensKey(issued.agentWallet), jti);
  await redis.expire(walletTokensKey(issued.agentWallet), REVOKED_JWT_TTL_S);
  await saveSession({ ...session, status: 'confirmed', ownerAddress: ownerAddress.toLowerCase(), apiKey }, SESSION_TTL_S);
  res.json({ success: true, data: { apiKey, agentWallet: session.agentWallet } } satisfies ApiResponse);
});

const RevokeSchema = z.union([
  z.object({ jti: z.string().regex(/^[0-9a-f]{32}$/, 'jti must be the token id (32 hex characters)') }),
  z.object({ agentWallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'agentWallet must be an address') }),
]);

/**
 * POST /api/v1/registration/revoke — revoke one registration token ({ jti }),
 * or every recorded one for an agent wallet ({ agentWallet }). Allowed for the
 * agent wallet itself and for the owner who confirmed the registration.
 * Works whether or not new registrations are enabled. Anything the caller
 * can't revoke looks the same as a token that doesn't exist.
 */
registrationRouter.post('/revoke', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const body = RevokeSchema.parse(req.body);
    const caller = new Set([req.user!.address, ...(req.user!.addresses ?? [])].map((a) => a.toLowerCase()));
    const jtis = 'jti' in body ? [body.jti] : await redis.smembers(walletTokensKey(body.agentWallet));
    let revoked = 0;
    for (const jti of jtis) {
      const raw = await redis.get(issuedKey(jti));
      if (!raw) continue;
      const issued = JSON.parse(raw) as IssuedToken;
      if (!caller.has(issued.agentWallet) && !caller.has(issued.ownerAddress)) continue;
      await redis.set(`revoked:jwt:${jti}`, '1', 'EX', REVOKED_JWT_TTL_S);
      void disconnectSocketsForToken(jti).catch(() => {});
      revoked++;
    }
    if (revoked === 0) {
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'No registration token you can revoke' } });
      return;
    }
    res.json({ success: true, data: { revoked } } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
});
