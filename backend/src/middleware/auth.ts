import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { timingSafeEqual } from 'crypto';
import { config } from '../config.js';
import { AppError } from './errorHandler.js';
import type { AuthRequest } from '../types.js';
import { lookupApiKey } from '../services/apiKeyStore.js';
import { redis } from '../services/redis.js';

/** Constant-time string comparison to prevent timing attacks on API keys */
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Check if a string is the configured legacy agent API key (timing-safe) */
function isLegacyAgentApiKey(candidate: string): boolean {
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

/**
 * The Privy user id in a verified Privy access token: its `sub`, a DID
 * (did:privy:…). Undefined when `sub` is anything else, such as the wallet
 * address extractAllWalletAddresses falls back to. Exported for tests.
 */
export function privyUserIdOf(payload: { sub?: unknown }): string | undefined {
  const sub = payload.sub;
  return typeof sub === 'string' && sub.startsWith('did:privy:') && sub.length <= 200 ? sub : undefined;
}

/** Verify a Privy JWT using jose */
async function verifyPrivyToken(token: string, activeChain?: string): Promise<{ address: string; addresses?: string[]; privyUserId?: string }> {
  const JWKS = await getJWKS();
  if (!JWKS) throw new Error('Privy not configured (missing PRIVY_APP_ID)');

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      audience: config.privyAppId,
    });

    const allWallets = extractAllWalletAddresses(payload as any);
    const allAddresses = allWallets.map(w => w.address);

    // Pick address based on active chain if provided
    const primary = activeChain
      ? getAddressForChain(allWallets, activeChain)
      : (allWallets.find(w => w.chainType === 'ethereum')?.address ?? allWallets[0]?.address ?? null);

    if (!primary) {
      console.warn(`[Auth] No wallet found in token. Available keys: ${Object.keys(payload).join(', ')}`);
      throw new Error('No wallet address in Privy token');
    }

    const privyUserId = privyUserIdOf(payload);
    return { address: primary, addresses: allAddresses, ...(privyUserId ? { privyUserId } : {}) };
  } catch (err: any) {
    throw err;
  }
}

/** Wallet address with chain type info from Privy JWT */
interface WalletAddress {
  address: string;
  chainType: 'ethereum' | string;
}

/** Extract all wallet addresses from Privy JWT claims, with chain type info */
function extractAllWalletAddresses(payload: any): WalletAddress[] {
  const addresses: WalletAddress[] = [];

  // 1. Check for the preferred 'wallet_address' claim (assume ethereum if no chain type)
  if (typeof payload.wallet_address === 'string') {
    addresses.push({ address: payload.wallet_address, chainType: 'ethereum' });
  }

  // 2. Check linked_accounts array
  let accounts = payload.linked_accounts;
  if (typeof accounts === 'string') {
    try {
      accounts = JSON.parse(accounts);
    } catch { /* ignore */ }
  }
  if (Array.isArray(accounts)) {
    for (const a of accounts) {
      if (a.type === 'wallet' && typeof a.address === 'string' && a.address.startsWith('0x')) {
        const chainType = a.chainType || a.chain_type || 'ethereum';
        if (!addresses.some(w => w.address === a.address)) {
          addresses.push({ address: a.address, chainType });
        }
      }
    }
  }

  // 3. Last resort: check sub if it's an address
  if (typeof payload.sub === 'string' && payload.sub.startsWith('0x')) {
    if (!addresses.some(w => w.address === payload.sub)) {
      addresses.push({ address: payload.sub, chainType: 'ethereum' });
    }
  }

  return addresses;
}

/** Get address for a specific chain type from wallet addresses */
function getAddressForChain(wallets: WalletAddress[], chainType: string): string | null {
  // First try exact chain type match
  const exact = wallets.find(w => w.chainType === chainType);
  if (exact) return exact.address;

  // Fall back: for 'og' chain, prefer ethereum
  if (chainType === 'og') {
    const eth = wallets.find(w => w.chainType === 'ethereum');
    if (eth) return eth.address;
  }

  // Ultimate fallback: return first address
  return wallets[0]?.address ?? null;
}

/**
 * Verify a registration-minted JWT (HS256, signed with JWT_SECRET in
 * routes/registration.ts). Identified by carrying both `address` and
 * `ownerAddress` claims — generic HS256 tokens without those are rejected,
 * so this isn't a re-introduction of the old SIWE end-user auth.
 *
 * Every token this successfully verifies came from a backend minter by
 * construction (only minters hold JWT_SECRET). The returned principal carries
 * `typ: 'agent-platform'` for server-minted worker tokens and
 * `typ: 'agent-registration'` for device-flow tokens (including tokens minted
 * before either claim existed). Callers that gate privileged roles (see
 * requireFounder) must reject on this field.
 */
const warnedCutoffs = new Set<string>();

/** A token cutoff from the environment, in Unix seconds (0 = unset). A value
 *  that isn't a positive integer used to become NaN and silently disable the
 *  cutoff; it is now reported. A millisecond value is converted, since it
 *  would otherwise reject every token. */
function tokenMinIat(name: string): number {
  const raw = process.env[name];
  if (!raw) return 0;
  let value = Number(raw);
  const warn = (message: string) => {
    if (!warnedCutoffs.has(name)) console.error(`[Auth] ${name}=${raw} ${message}`);
    warnedCutoffs.add(name);
  };
  if (!Number.isInteger(value) || value <= 0) {
    warn('is not a Unix time in seconds; the cutoff is NOT applied');
    return 0;
  }
  if (value > 1e11) {
    warn('looks like milliseconds; using it as seconds / 1000');
    value = Math.floor(value / 1000);
  }
  return value;
}

export function verifyRegistrationToken(
  token: string,
  // quiet: log no rejection. The rate limiter checks the token of every
  // request that claims to be a worker's, including the ones it refuses.
  { quiet = false }: { quiet?: boolean } = {},
): { address: string; ownerAddress?: string; typ: 'agent-registration' | 'agent-platform'; jti?: string } | null {
  const warn = quiet ? () => {} : console.warn;
  if (!config.jwtSecret) {
    warn('[Auth] Registration token rejected: JWT_SECRET not configured');
    return null;
  }
  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    if (typeof payload === 'string' || !payload) {
      warn('[Auth] Registration token rejected: Invalid payload type');
      return null;
    }
    const claims = payload as Record<string, unknown>;
    if (typeof claims.address !== 'string' || typeof claims.ownerAddress !== 'string') {
      warn('[Auth] Registration token rejected: Missing address or ownerAddress claims', Object.keys(claims));
      return null;
    }
    // M6 (audit): honor the minter's typ, allowlisted — server-minted worker
    // tokens carry 'agent-platform', device-flow tokens 'agent-registration'
    // (or nothing, pre-typ). Anything else falls back to the unprivileged
    // registration flavor; it can never escalate by self-declaring.
    const typ = claims.typ === 'agent-platform' ? 'agent-platform' : 'agent-registration';
    // Each class has its own cutoff, so killing device-flow tokens no longer
    // kills every hosted worker's token too (security audit run 1, C27).
    const cutoffName = typ === 'agent-platform' ? 'PLATFORM_TOKEN_MIN_IAT' : 'REGISTRATION_TOKEN_MIN_IAT';
    const minIat = tokenMinIat(cutoffName);
    if (minIat > 0 && (typeof claims.iat !== 'number' || claims.iat < minIat)) {
      warn(`[Auth] Registration token rejected: issued before ${cutoffName}`);
      return null;
    }
    return {
      address: claims.address,
      ownerAddress: claims.ownerAddress as string,
      typ,
      jti: typeof claims.jti === 'string' ? claims.jti : undefined,
    };
  } catch (err: any) {
    if (!quiet) console.debug('[Auth] Registration token check (not HS256 — trying Privy):', err.message);
    return null;
  }
}

/**
 * M3 (audit): per-token revocation for the 365-day HS256 JWTs (worker
 * platform tokens, registration tokens). Owners revoke via
 * POST /agents/:id/revoke-token, which sets `revoked:jwt:<jti>`; every
 * verifyRegistrationToken success is checked here before the principal is
 * attached. Device-flow registration tokens are revoked through
 * POST /registration/revoke. TTL (366d) covers the max token lifetime so flags
 * die with the tokens they kill. Pre-jti tokens grandfather through — rotate
 * them out via REGISTRATION_TOKEN_MIN_IAT (or PLATFORM_TOKEN_MIN_IAT for
 * hosted-worker tokens).
 *
 * Fail-open on Redis outage (availability over revocation, same precedent as
 * the sandbox quota): a revoked token works until Redis recovers. Logged
 * loudly so the gap is visible, not silent.
 */
export const REVOKED_JWT_TTL_S = 366 * 24 * 3600;

export async function isJwtRevoked(jti: string | undefined): Promise<boolean> {
  if (!jti) return false;
  try {
    return (await redis.get(`revoked:jwt:${jti}`)) !== null;
  } catch {
    console.warn('[Auth] revocation denylist unavailable — failing open');
    return false;
  }
}

/**
 * The hosted agent whose platform token `req` carries, as its lowercased
 * wallet address, or null. A platform token is the server-minted worker
 * token (typ 'agent-platform'); it counts only when verifyRegistrationToken
 * accepts it and it is not revoked, the checks requireAuth makes. Anything
 * else is null: no Bearer token, a Privy token, an API key, a device-flow
 * token, or a forged, expired or revoked one. Runs before any route's auth,
 * for the rate limiter (middleware/rateLimit.ts).
 */
export async function verifiedPlatformAgent(req: Request): Promise<string | null> {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) return null;
  // Only a token that says it is a worker's is checked, so other requests
  // cost no verification. What it says is not trusted:
  // verifyRegistrationToken checks the signature and sets typ itself.
  const claimed = jwt.decode(token);
  if (!claimed || typeof claimed !== 'object' || claimed.typ !== 'agent-platform') return null;
  const principal = verifyRegistrationToken(token, { quiet: true });
  if (principal?.typ !== 'agent-platform') return null;
  if (await isJwtRevoked(principal.jti)) return null;
  return principal.address.toLowerCase();
}

/**
 * Auth middleware: accepts Privy JWT, registration-minted JWT, DB-backed API key,
 * or legacy X-API-Key (AGENT_API_KEY env var).
 * Attaches `req.user = { address }` on success.
 */
export function requireAuth(req: AuthRequest, _res: Response, next: NextFunction): void {
  // 1. Check X-API-Key header (for SDK agents)
  const apiKey = req.headers['x-api-key'] as string | undefined;

  // 2. Check Authorization: Bearer <token>
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

  // 3. Check X-Active-Chain header (for chain: 'og')
  const activeChain = req.headers['x-active-chain'] as string | undefined;

  const candidate = apiKey || token;
  if (!candidate) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  }

  // Check DB-backed API key (async)
  lookupApiKey(candidate).then(async (key) => {
    if (key) {
      req.user = { address: key.ownerAddress, addresses: [key.ownerAddress] };
      next();
      return;
    }

    // Fall through to legacy / JWT checks
    if (isLegacyAgentApiKey(candidate)) {
      req.user = { address: 'agent' };
      next();
      return;
    }

    // Registration-minted JWT (CLI/SDK agents)
    if (token) {
      const regUser = verifyRegistrationToken(token);
      if (regUser) {
        if (await isJwtRevoked(regUser.jti)) {
          next(new AppError(401, 'TOKEN_REVOKED', 'This token has been revoked by the owner'));
          return;
        }
        req.user = regUser;
        next();
        return;
      }

      // Privy JWT (browser users) — pass activeChain to pick correct address
      verifyPrivyToken(token, activeChain)
        .then((user) => {
          req.user = user;
          next();
        })
        .catch((err) => {
          console.error('[Auth] Privy verification failed:', err.message);
          next(new AppError(401, 'INVALID_TOKEN', `Invalid or expired token: ${err.message}`));
        });
      return;
    }

    throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  }).catch((err) => {
    // The 401 thrown above lands here too: pass an AppError through, or an
    // unknown X-API-Key answered 500 AUTH_ERROR instead of 401.
    // Anything else is an infrastructure failure (database, Redis). Its text
    // named the database host to anonymous callers (security audit run 1,
    // C23), so it is logged here and the client gets a fixed message.
    if (err instanceof AppError) {
      next(err);
      return;
    }
    console.error('[Auth] authentication backend error:', err);
    next(new AppError(500, 'AUTH_ERROR', 'Authentication is temporarily unavailable'));
  });
}

/**
 * Founder gate. Run AFTER requireAuth — checks req.user.address against
 * the FOUNDER_ADDRESSES env var (comma-separated, case-insensitive).
 * Treats absence of FOUNDER_ADDRESSES as "no one is a founder" so production
 * deploys never accidentally expose admin views.
 */
export function requireFounder(req: AuthRequest, _res: Response, next: NextFunction): void {
  // A founder authenticates through Privy, never through an HS256 worker
  // token of either flavor — reject the issuer outright, before comparing
  // addresses. This check is keyed on the issuer (verifyRegistrationToken
  // always sets typ), not on a forgeable claim inside the token.
  if (req.user?.typ !== undefined) {
    next(new AppError(403, 'FORBIDDEN', 'Founder access required'));
    return;
  }

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
 * DB-backed API key / legacy API key token is present, continues regardless.
 */
export function optionalAuth(req: AuthRequest, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const apiKey = req.headers['x-api-key'] as string | undefined;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
  const activeChain = req.headers['x-active-chain'] as string | undefined;
  const candidate = apiKey || token;
  if (!candidate) {
    next();
    return;
  }

  // Try DB-backed API key
  lookupApiKey(candidate).then(async (key) => {
    if (key) {
      req.user = { address: key.ownerAddress, addresses: [key.ownerAddress] };
      next();
      return;
    }

    if (!token) {
      next();
      return;
    }

    // Legacy API key
    if (isLegacyAgentApiKey(token)) {
      req.user = { address: 'agent' };
      next();
      return;
    }

    // Registration-minted JWT
    const regUser = verifyRegistrationToken(token);
    if (regUser) {
      // Revoked worker tokens must not linger via optional-auth surfaces
      // (e.g. resultData on GET /tasks/:id).
      if (await isJwtRevoked(regUser.jti)) {
        next();
        return;
      }
      req.user = regUser;
      next();
      return;
    }

    // Privy JWT
    verifyPrivyToken(token, activeChain)
      .then((user) => {
        req.user = user;
        next();
      })
      .catch(() => next());
  }).catch(() => next());
}
