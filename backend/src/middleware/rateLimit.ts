import rateLimit from 'express-rate-limit';
import type { Request, RequestHandler } from 'express';
import type { AuthRequest } from '../types.js';
import { verifiedPlatformAgent } from './auth.js';

// ── Hosted agents ───────────────────────────────────────────────────────────
//
// Every hosted agent is a worker this server forks, and it calls the API at
// BACKEND_URL, which is localhost (services/agentRunner.ts). By IP they are
// one client: all of them shared one 100/min bucket. A restart re-forks every
// worker at once and each sends 4 requests as it boots, so from 26 agents
// some were refused, among them executor registrations. So a request
// carrying a verified agent platform token (hostedAgentOf) is limited per
// agent, not per IP. Loopback is not exempted by address: behind a reverse
// proxy on this box, outside traffic would look local too. Like every limit
// here, the buckets are per process; a worker only calls the process that
// forked it.

/** Requests a minute one hosted agent may send, outside the posting routes. */
export const AGENT_REQUESTS_PER_MIN = 300;

const agentOfRequest = new WeakMap<Request, Promise<string | null>>();

/**
 * The hosted agent behind `req` (verifiedPlatformAgent), looked up once per
 * request however many limiters ask. Null for anything else, a forged or
 * revoked token included, so those stay limited by IP.
 */
export function hostedAgentOf(req: Request): Promise<string | null> {
  let agent = agentOfRequest.get(req);
  if (!agent) {
    agent = verifiedPlatformAgent(req).catch(() => null);
    agentOfRequest.set(req, agent);
  }
  return agent;
}

// ── Posting routes (docs/BULK-POSTING.md) ───────────────────────────────────
//
// An authenticated call to a posting route is limited per wallet, not per IP,
// so a bulk run doesn't starve the other users behind the same IP (a NAT, a
// VPN, or every hosted agent). Three limits apply:
//   - createRateLimiter, the global 100/min per IP, skips a posting call that
//     presents credentials;
//   - createPostingAuthLimiter counts, per IP, the posting calls whose
//     credentials fail, 100/min: unauthenticated callers keep the per-IP
//     limit, and a flood of bad tokens can't reach requireAuth (a database
//     lookup each) unlimited. A hosted agent's verified token is not one;
//   - createWalletBudget, mounted after requireAuth on each posting route,
//     limits the authenticated wallet, and postingIpBudget (600 items a
//     minute per IP, across all six routes) caps what one address can send
//     however many wallets it authenticates as. For hosted agents, which
//     all share this server's address, it caps each owner instead.

/** The posting routes, as full paths. */
export const POSTING_ROUTES: ReadonlySet<string> = new Set([
  '/api/v1/tasks',
  '/api/v1/tasks/batch',
  '/api/v1/a2a/tasks/index',
  '/api/v1/a2a/tasks/index-batch',
  '/api/v1/storage/upload',
  '/api/v1/storage/upload-batch',
]);

/** Whether `req` presents credentials as requireAuth reads them: an X-API-Key, else a Bearer token. */
function presentsCredentials(req: Request): boolean {
  const apiKey = req.headers['x-api-key'];
  const auth = req.headers.authorization;
  const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return (typeof apiKey === 'string' && apiKey.length > 0) || token.length > 0;
}

/**
 * A POST to a posting route that presents credentials. Matched as Express
 * routes it: any letter case, trailing slashes ignored. A spelling that does
 * not match is simply limited per IP.
 */
export function isCredentialedPosting(req: Request): boolean {
  if (req.method !== 'POST') return false;
  const path = `${req.baseUrl}${req.path}`.toLowerCase().replace(/\/+$/, '');
  return POSTING_ROUTES.has(path) && presentsCredentials(req);
}

const RATE_LIMIT_MESSAGE = {
  success: false,
  error: { code: 'RATE_LIMIT', message: 'Too many requests, please try again later' },
};

/**
 * 100 requests per minute per IP, and AGENT_REQUESTS_PER_MIN per hosted
 * agent for requests carrying its verified platform token (see above), which
 * then don't count toward their IP's 100. Posting calls that present
 * credentials skip both (see above). Two limiters, one after the other: a
 * request is counted by the one that applies to it.
 */
export function createRateLimiter(): RequestHandler {
  const perIp = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    skip: async (req) => isCredentialedPosting(req) || (await hostedAgentOf(req)) !== null,
    message: RATE_LIMIT_MESSAGE,
  });
  const perAgent = rateLimit({
    windowMs: 60 * 1000,
    max: AGENT_REQUESTS_PER_MIN,
    standardHeaders: true,
    legacyHeaders: false,
    skip: async (req) => isCredentialedPosting(req) || (await hostedAgentOf(req)) === null,
    keyGenerator: async (req) => `agent:${await hostedAgentOf(req)}`,
    message: RATE_LIMIT_MESSAGE,
  });
  return (req, res, next) => perIp(req, res, (err?: unknown) => (err ? next(err) : perAgent(req, res, next)));
}

/**
 * 100 posting calls per minute per IP whose credentials fail. A call counts
 * when it arrives and stops counting once it has authenticated (req.user
 * set), so only unauthenticated calls use this limit. A hosted agent's call
 * is not counted at all: its token is verified already (hostedAgentOf), and
 * counted, every agent's in-flight uploads would share this server's 100.
 * Mount right after createRateLimiter(), before the body is parsed.
 */
export function createPostingAuthLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    // The wallet budget's headers describe these routes.
    standardHeaders: false,
    legacyHeaders: false,
    skip: async (req) => !isCredentialedPosting(req) || (await hostedAgentOf(req)) !== null,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (req) => Boolean((req as AuthRequest).user),
    message: RATE_LIMIT_MESSAGE,
  });
}

/** Most buckets one limiter keeps; past this the least recently used are dropped. */
const MAX_BUCKETS = 20_000;

/**
 * A token bucket per `key(req)`: it holds `perMinute` items and refills at
 * `perMinute` a minute. A request spends `weight(req)` items (1, or its
 * batch's size, at most the whole bucket), and is refused with 429 and
 * Retry-After, spending nothing, when the bucket holds fewer. It refills
 * steadily rather than at the end of a window, so a client that backs off a
 * few seconds gets through again. In memory, per process, like the
 * express-rate-limit stores, and bounded: buckets that have refilled are
 * dropped once a minute, and past MAX_BUCKETS the least recently used go.
 */
function createTokenBucket({
  perMinute,
  weight,
  key,
  refusal,
  maxBuckets = MAX_BUCKETS,
}: {
  perMinute: number;
  weight?: (req: Request) => number;
  key: (req: Request) => string;
  /** The 429 message, given the seconds until the request would fit and the bucket's key. */
  refusal: (retryAfter: number, id: string) => string;
  maxBuckets?: number;
}): RequestHandler {
  const capacity = perMinute;
  const refillPerMs = perMinute / 60_000;
  // Insertion order is kept as last use: a bucket is re-inserted on each use.
  const buckets = new Map<string, { tokens: number; at: number }>();
  let lastSweep = Date.now();
  const put = (id: string, bucket: { tokens: number; at: number }) => {
    buckets.delete(id);
    buckets.set(id, bucket);
    while (buckets.size > maxBuckets) buckets.delete(buckets.keys().next().value as string);
  };
  return (req, res, next) => {
    const now = Date.now();
    // Drop buckets that have refilled: they are the same as absent ones.
    if (now - lastSweep > 60_000) {
      for (const [id, bucket] of buckets) {
        if (bucket.tokens + (now - bucket.at) * refillPerMs >= capacity) buckets.delete(id);
      }
      lastSweep = now;
    }

    const id = key(req);
    const raw = weight ? weight(req) : 1;
    const cost = Math.min(capacity, Math.max(1, Number.isFinite(raw) ? Math.floor(raw) : 1));
    const bucket = buckets.get(id);
    const tokens = bucket ? Math.min(capacity, bucket.tokens + (now - bucket.at) * refillPerMs) : capacity;

    res.setHeader('RateLimit-Limit', String(capacity));
    if (tokens < cost) {
      put(id, { tokens, at: now });
      const retryAfter = Math.max(1, Math.ceil((cost - tokens) / refillPerMs / 1000));
      res.setHeader('RateLimit-Remaining', String(Math.floor(tokens)));
      res.setHeader('RateLimit-Reset', String(retryAfter));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ success: false, error: { code: 'RATE_LIMIT', message: refusal(retryAfter, id) } });
      return;
    }
    put(id, { tokens: tokens - cost, at: now });
    res.setHeader('RateLimit-Remaining', String(Math.floor(tokens - cost)));
    next();
  };
}

/**
 * Each wallet's budget on one family of posting routes: a token bucket
 * (createTokenBucket) of `perMinute` items, refilling at `perMinute` a minute
 * (2/s at 120). Mount AFTER requireAuth; a request with no wallet (a miswired
 * route) is limited by IP.
 */
export function createWalletBudget({
  name,
  perMinute,
  weight,
  maxBuckets,
}: {
  /** What is counted, in the 429 message ("task builds"). */
  name: string;
  perMinute: number;
  weight?: (req: Request) => number;
  maxBuckets?: number;
}): RequestHandler {
  return createTokenBucket({
    perMinute,
    weight,
    maxBuckets,
    key: (req) => {
      const wallet = (req as AuthRequest).user?.address?.toLowerCase();
      return wallet ? `wallet:${wallet}` : `ip:${req.ip ?? 'unknown'}`;
    },
    refusal: (retryAfter) => `Too many ${name} for this wallet: at most ${perMinute} a minute. Retry in ${retryAfter}s.`,
  });
}

/** A wallet budget weight: the length of the body's `field` array (a batch), else 1. */
export function batchWeight(field: string): (req: Request) => number {
  return (req) => {
    const list = (req.body as Record<string, unknown> | undefined)?.[field];
    return Array.isArray(list) ? list.length : 1;
  };
}

/**
 * Items one IP may send a minute across all the posting routes, whichever
 * wallets it authenticates as: a ceiling over the wallet budgets, so one
 * address can't multiply them by minting keys (with REGISTRATION_ENABLED a
 * new key is a year-long token) into platform-paid 0G uploads and listings.
 * Five times one wallet's budget for a family: a wallet posting flat out
 * spends at most 360 a minute across the three, so an IP fits more than one
 * such bulk run, or many ordinary posters behind a NAT.
 */
export const IP_POSTING_BUDGET_PER_MIN = 600;

/**
 * The per-IP ceiling (IP_POSTING_BUDGET_PER_MIN), one bucket per IP shared
 * by every posting route. A request spends one item, or its batch's size
 * (`tasks` or `items`). Mount after requireAuth and the route's wallet
 * budget, so a wallet over its own budget is refused before it can drain the
 * budget it shares with the rest of its IP.
 *
 * A hosted agent (requireAuth's typ 'agent-platform') is capped by its owner
 * instead: every hosted agent posts from this server, so per IP one owner's
 * agents could spend the ceiling every other owner's agents need for their
 * result uploads. The owner is what multiplies wallets here, one per agent.
 */
export function createPostingIpBudget({ maxBuckets }: { maxBuckets?: number } = {}): RequestHandler {
  return createTokenBucket({
    perMinute: IP_POSTING_BUDGET_PER_MIN,
    maxBuckets,
    weight: (req) => {
      const body = req.body as Record<string, unknown> | undefined;
      const list = Array.isArray(body?.tasks) ? body.tasks : Array.isArray(body?.items) ? body.items : null;
      return list ? list.length : 1;
    },
    key: (req) => {
      const user = (req as AuthRequest).user;
      return user?.typ === 'agent-platform' && user.ownerAddress
        ? `owner:${user.ownerAddress.toLowerCase()}`
        : `ip:${req.ip ?? 'unknown'}`;
    },
    refusal: (retryAfter, id) =>
      `Too many posting requests ${id.startsWith('owner:') ? "from this owner's hosted agents" : 'from this network address'}: at most ${IP_POSTING_BUDGET_PER_MIN} items a minute across uploads, builds and listings. Retry in ${retryAfter}s.`,
  });
}

/** The process's one per-IP posting ceiling, mounted on all six posting routes. */
export const postingIpBudget = createPostingIpBudget();

/**
 * Per-authenticated-principal limiter for routes that trigger a PAID provider
 * call (embeddings / rerank). Keyed by the caller's wallet address, so rotating
 * IPs doesn't bypass it and every registered agent is capped individually.
 * Mount AFTER requireAuth so req.user is set. Falls back to IP for the
 * (shouldn't-happen) unauthenticated case.
 */
export function createUserRateLimiter(maxPerMinute: number) {
  return rateLimit({
    windowMs: 60 * 1000,
    max: maxPerMinute,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => (req as AuthRequest).user?.address?.toLowerCase() || req.ip || 'anon',
    message: {
      success: false,
      error: { code: 'RATE_LIMIT', message: 'Too many matching requests — slow down' },
    },
  });
}
