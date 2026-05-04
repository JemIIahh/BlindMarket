import type { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { timingSafeEqual } from 'crypto';
import { config } from '../config.js';
import { AppError } from './errorHandler.js';
import type { AuthRequest } from '../types.js';

/** Constant-time string comparison to prevent timing attacks on API keys */
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Check if a string is the configured agent API key (timing-safe) */
function isAgentApiKey(candidate: string): boolean {
  return !!(config.agentApiKey && safeCompare(candidate, config.agentApiKey));
}

// Jose-based JWKS set
let remoteJWKSet: ReturnType<typeof createRemoteJWKSet> | null = null;

async function getJWKS() {
  if (!config.privyAppId) return null;
  if (remoteJWKSet) return remoteJWKSet;

  const app_id = config.privyAppId;
  const urls = [
    `https://auth.privy.io/api/v1/apps/${app_id}/jwks.json`,
    `https://auth.privy.io/api/v1/apps/${app_id}/jwks`,
    `https://auth.privy.io/api/v1/apps/${app_id}/.well-known/jwks.json`,
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        console.log(`[Auth] JWKS found at: ${url}`);
        remoteJWKSet = createRemoteJWKSet(new URL(url));
        return remoteJWKSet;
      }
      console.warn(`[Auth] JWKS not found at ${url} (Status: ${res.status})`);
    } catch (err: any) {
      console.warn(`[Auth] Failed to reach ${url}: ${err.message}`);
    }
  }

  // Diagnostic: check if the app exists at all
  try {
    const appRes = await fetch(`https://auth.privy.io/api/v1/apps/${app_id}`);
    console.warn(`[Auth] Diagnostic base app check (${app_id}): ${appRes.status} ${appRes.statusText}`);
  } catch (e: any) {
    console.warn(`[Auth] Diagnostic base app check failed: ${e.message}`);
  }

  // Fallback to the first one even if it failed, so jose can try its own internal fetch/retry
  remoteJWKSet = createRemoteJWKSet(new URL(urls[0]));
  return remoteJWKSet;
}

/** Verify a Privy JWT using jose */
async function verifyPrivyToken(token: string): Promise<{ address: string }> {
  const JWKS = await getJWKS();
  if (!JWKS) throw new Error('Privy not configured (missing PRIVY_APP_ID)');

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: 'privy.io',
      audience: config.privyAppId,
    });

    // Extract wallet address from Privy token claims
    const walletAddress = extractWalletAddress(payload as any);
    if (!walletAddress || !walletAddress.startsWith('0x')) {
      // Debug log the claims if we can't find a wallet
      console.warn(`[Auth] No wallet found in token. Claims:`, JSON.stringify(payload));
      throw new Error(`No wallet address in Privy token (found: ${walletAddress})`);
    }

    return { address: walletAddress };
  } catch (err: any) {
    throw err;
  }
}

/** Extract wallet address from Privy JWT claims */
function extractWalletAddress(payload: any): string | null {
  // 1. Check for the preferred 'wallet_address' claim (often present in v2 or specific configs)
  if (typeof payload.wallet_address === 'string') return payload.wallet_address;

  // 2. Check linked_accounts array
  const accounts = payload.linked_accounts;
  if (Array.isArray(accounts)) {
    // Prioritize embedded wallets or external wallets
    const wallet = accounts.find((a: any) => a.type === 'wallet' && a.address?.startsWith('0x'));
    if (wallet) return wallet.address;
  }

  // 3. Last resort: check sub if it's an address (unlikely but possible)
  if (typeof payload.sub === 'string' && payload.sub.startsWith('0x')) return payload.sub;

  return null;
}

/**
 * Verify a registration-minted JWT (HS256, signed with JWT_SECRET in
 * routes/registration.ts). Identified by carrying both `address` and
 * `ownerAddress` claims — generic HS256 tokens without those are rejected,
 * so this isn't a re-introduction of the old SIWE end-user auth.
 */
function verifyRegistrationToken(token: string): { address: string } | null {
  if (!config.jwtSecret) return null;
  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    if (typeof payload === 'string' || !payload) return null;
    const claims = payload as Record<string, unknown>;
    if (typeof claims.address !== 'string' || typeof claims.ownerAddress !== 'string') {
      return null;
    }
    return { address: claims.address };
  } catch {
    return null;
  }
}

/**
 * Auth middleware: accepts Privy JWT, registration-minted JWT, or X-API-Key.
 * Attaches `req.user = { address }` on success.
 */
export function requireAuth(req: AuthRequest, _res: Response, next: NextFunction): void {
  // 1. Check X-API-Key header (for agent operations)
  const apiKey = req.headers['x-api-key'] as string | undefined;
  if (apiKey && isAgentApiKey(apiKey)) {
    req.user = { address: 'agent' };
    next();
    return;
  }

  // 2. Check Authorization: Bearer <token>
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  }

  const token = authHeader.slice(7);

  // 2a. Shared API key passed as Bearer
  if (isAgentApiKey(token)) {
    req.user = { address: 'agent' };
    next();
    return;
  }

  // 2b. Registration-minted JWT (CLI/SDK agents)
  const regUser = verifyRegistrationToken(token);
  if (regUser) {
    req.user = regUser;
    next();
    return;
  }

  // 2c. Privy JWT (browser users)
  verifyPrivyToken(token)
    .then((user) => {
      req.user = user;
      next();
    })
    .catch((err) => {
      console.error('[Auth] Privy verification failed:', err.message);
      // Pass original error message for easier debugging
      next(new AppError(401, 'INVALID_TOKEN', `Invalid or expired token: ${err.message}`));
    });
}

/**
 * Founder gate. Run AFTER requireAuth — checks req.user.address against
 * the FOUNDER_ADDRESSES env var (comma-separated, case-insensitive).
 * Treats absence of FOUNDER_ADDRESSES as "no one is a founder" so production
 * deploys never accidentally expose admin views.
 */
export function requireFounder(req: AuthRequest, _res: Response, next: NextFunction): void {
  const raw = process.env.FOUNDER_ADDRESSES || '';
  const founders = new Set(
    raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  );

  const address = req.user?.address?.toLowerCase();
  if (!address || !founders.has(address)) {
    next(new AppError(403, 'FORBIDDEN', 'Founder access required'));
    return;
  }
  next();
}

/**
 * Optional auth — attaches user if a valid Privy / registration-JWT /
 * API-key token is present, continues regardless.
 */
export function optionalAuth(req: AuthRequest, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    next();
    return;
  }

  const token = authHeader.slice(7);

  // API key check
  const apiKey = req.headers['x-api-key'] as string | undefined;
  if ((apiKey && isAgentApiKey(apiKey)) || isAgentApiKey(token)) {
    req.user = { address: 'agent' };
    next();
    return;
  }

  // Registration-minted JWT
  const regUser = verifyRegistrationToken(token);
  if (regUser) {
    req.user = regUser;
    next();
    return;
  }

  verifyPrivyToken(token)
    .then((user) => {
      req.user = user;
      next();
    })
    .catch(() => next());
}
