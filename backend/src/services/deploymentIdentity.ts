/**
 * Which deployment owns this Redis, and whether this process may write shared
 * state on its own initiative.
 *
 * A2A keys are not namespaced by chain or deployment, so every backend on a
 * Redis reads and writes the same queue and index. On 2026-05-25 a local
 * testnet backend pointed at production's Redis poached a mainnet task. A
 * staging stack gets its own Redis; this is the tripwire for when a process
 * lands on someone else's.
 *
 * A deployment names itself with DEPLOYMENT_ID and claims an unclaimed Redis
 * (IDENTITY_KEY = {id, tier, chains}). A process that finds the Redis belongs
 * to another deployment stops its BACKGROUND WRITES: the indexers (including
 * the passes request paths force), the sweeps, the AgentFactory listener, the
 * CCTP poller, agent reconcile and agent starts. Each checks
 * backgroundWritesAllowed() when it runs, so a verdict reached late (Redis was
 * down at boot) still takes effect. HTTP still serves.
 *
 * Production can never be stopped. Only a STOPPABLE process can: a staging
 * stack (DEPLOYMENT_SET=staging or SETTLEMENT_TIER=testnet) or anything not
 * running as production (NODE_ENV != production: local development, where the
 * 2026-05-25 backend ran). Production claims regardless of what it finds, and
 * only logs a record or index keys that disagree with it — whatever another
 * process wrote there, including a planted fingerprint, cannot turn it off.
 *
 * A stoppable process:
 * - with a DEPLOYMENT_ID, claims only a Redis with no other deployment's data:
 *   no record, no escrow fingerprint for an escrow it does not index, and no
 *   indexer checkpoint without a fingerprint (production's history from before
 *   fingerprints). DEPLOYMENT_CLAIM=true, set for one boot, claims anyway: the
 *   way to take back a stack's own Redis after its record was lost or its
 *   chains changed.
 * - without one (local development), stops only on positive evidence: another
 *   deployment's record, or a fingerprint for another escrow. A checkpoint
 *   with no fingerprint is only logged, so an old local Redis keeps working.
 *
 * A Redis error leaves writes on (failing closed would stop the owner on a
 * blip) and the check is retried every minute until it gets an answer.
 */

import * as Sentry from '@sentry/node';
import { config } from '../config.js';
import { redis } from './redis.js';
import { settlementChainConfigs } from './settlementChains.js';
import { FINGERPRINT_KEY } from './escrowFingerprint.js';
import type { SettlementTier } from './settlementTier.js';

export const IDENTITY_KEY = 'deployment:identity';

/** The TaskCreated checkpoint each indexer keeps (escrowEvents.ts and baseEscrowEvents.ts KEY.checkpoint). */
export const INDEX_CHECKPOINT_KEY: Readonly<Record<keyof typeof FINGERPRINT_KEY, string>> = {
  '0g': 'a2a:events:checkpoint',
  base: 'base:events:checkpoint',
};

/** How long boot waits for Redis before letting the writers run anyway. */
export const CHECK_TIMEOUT_MS = 10_000;
/** How often an unanswered check is retried. */
export const RETRY_MS = 60_000;

export interface DeploymentFacts {
  tier: SettlementTier | null;
  /** Each chain this deployment has an escrow on. */
  chains: Record<string, { chainId: number; escrow: string }>;
}

export interface IdentityRecord extends DeploymentFacts {
  id: string;
  claimedAt: string;
  updatedAt: string;
}

/**
 * owner     — DEPLOYMENT_ID matches the record, or this process claimed it.
 * not-owner — this Redis belongs to another deployment (a production process
 *             is told so but keeps writing).
 * unset     — no DEPLOYMENT_ID and no evidence against it.
 * unknown   — no answer from Redis yet; writes run, the check is retried.
 */
export type IdentityRole = 'owner' | 'not-owner' | 'unset' | 'unknown';

export interface IdentityStatus {
  deploymentId: string | null;
  role: IdentityRole;
  /** The recorded owner's id, when there is a record. */
  owner: string | null;
  writersAllowed: boolean;
  reason: string | null;
}

export interface IdentityRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: 'NX'): Promise<'OK' | null>;
}

/** Who this process is, as the rules above need it. */
export interface Self {
  deploymentId: string | null;
  facts: DeploymentFacts;
  /** A staging stack or a non-production process: the only kind that can be stopped. */
  stoppable: boolean;
  /** Only a stoppable process ever reads this: production claims anyway. */
  forceClaim: boolean;
}

/** This process's facts, from the settlement registry. */
export function currentFacts(): DeploymentFacts {
  const chains: DeploymentFacts['chains'] = {};
  for (const entry of settlementChainConfigs()) {
    if (entry.escrowAddress) chains[entry.key] = { chainId: entry.chainId, escrow: entry.escrowAddress.toLowerCase() };
  }
  return { tier: config.settlementTier, chains };
}

/**
 * Whether this process can be stopped. Production (NODE_ENV=production on the
 * default deployment set and not a testnet tier) never can; SETTLEMENT_TIER=
 * mainnet, set at the mainnet flip, does not change that.
 */
export function isStoppable(): boolean {
  return config.deploymentSet !== '' || config.settlementTier === 'testnet' || config.nodeEnv !== 'production';
}

export function currentSelf(): Self {
  return { deploymentId: config.deploymentId, facts: currentFacts(), stoppable: isStoppable(), forceClaim: config.deploymentClaim };
}

function parseRecord(raw: string | null): IdentityRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as IdentityRecord;
    const chainsOk = !!parsed?.chains && typeof parsed.chains === 'object'
      && Object.values(parsed.chains).every((c) => !!c && Number.isInteger(c.chainId) && typeof c.escrow === 'string');
    return parsed && typeof parsed.id === 'string' && chainsOk ? parsed : null;
  } catch {
    return null;
  }
}

/** Chains the record has on another chain id than this process: another network. */
function movedChains(record: DeploymentFacts, facts: DeploymentFacts): string[] {
  return Object.entries(record.chains)
    .filter(([key, c]) => facts.chains[key] && facts.chains[key].chainId !== c.chainId)
    .map(([key, c]) => `${key} ${c.chainId}→${facts.chains[key].chainId}`);
}

/**
 * What in this Redis says it holds another deployment's index, every key of
 * it. `positive`: a fingerprint for an escrow this process does not index.
 * `weak`: a checkpoint with no fingerprint (production before fingerprints).
 * Looks at every chain's keys: the A2A queue is shared whichever chains a
 * deployment settles on.
 */
async function foreignIndexState(store: IdentityRedis, facts: DeploymentFacts): Promise<{ positive: string[]; weak: string[] }> {
  const positive: string[] = [];
  const weak: string[] = [];
  for (const [chain, key] of Object.entries(FINGERPRINT_KEY)) {
    const fingerprint = await store.get(key);
    const mine = facts.chains[chain];
    if (fingerprint !== null) {
      const expected = mine ? `${mine.chainId}:${mine.escrow}` : null;
      if (fingerprint !== expected) positive.push(`${key}=${fingerprint} (this process: ${expected ?? `no ${chain} escrow`})`);
    } else {
      const checkpoint = INDEX_CHECKPOINT_KEY[chain as keyof typeof INDEX_CHECKPOINT_KEY];
      if ((await store.get(checkpoint)) !== null) weak.push(`${checkpoint} with no ${key}`);
    }
  }
  return { positive, weak };
}

const allowed = (self: Self, role: IdentityRole, owner: string | null, reason: string | null): IdentityStatus =>
  ({ deploymentId: self.deploymentId, role, owner, writersAllowed: true, reason });

/** Stop a stoppable process; a production process is told and keeps writing. */
const disagree = (self: Self, owner: string | null, reason: string): IdentityStatus =>
  self.stoppable
    ? { deploymentId: self.deploymentId, role: 'not-owner', owner, writersAllowed: false, reason }
    : { deploymentId: self.deploymentId, role: 'not-owner', owner, writersAllowed: true, reason: `${reason}. This is production, which is never stopped; if this Redis is not production's, fix REDIS_URL` };

/**
 * Decide this process's role, claiming the Redis when it may. Pure apart from
 * `store`; checkDeploymentIdentity() wraps it with the real Redis, a timeout,
 * retries and logging.
 */
export async function resolveIdentity(
  store: IdentityRedis,
  self: Self,
  now: () => Date = () => new Date(),
): Promise<IdentityStatus> {
  const { deploymentId, facts } = self;
  const record = parseRecord(await store.get(IDENTITY_KEY));
  const at = () => now().toISOString();

  if (!deploymentId) {
    if (record) {
      const differs = movedChains(record, facts).length > 0 || Object.keys(facts.chains).some((key) => !record.chains[key]);
      return differs
        ? disagree(self, record.id, `this Redis belongs to deployment "${record.id}" (${Object.entries(record.chains).map(([k, c]) => `${k} ${c.chainId}`).join(', ')}), whose chains are not this process's; give this process its own REDIS_URL`)
        : allowed(self, 'unset', record.id, null);
    }
    const { positive, weak } = await foreignIndexState(store, facts);
    if (positive.length > 0) {
      return disagree(self, null, `this Redis holds another deployment's index (${positive.join('; ')}); give this process its own REDIS_URL`);
    }
    return allowed(self, 'unset', null, weak.length > 0 ? `this Redis has index state this process cannot vouch for (${weak.join('; ')})` : null);
  }

  // Taking over, on purpose, for one boot.
  if (self.forceClaim && self.stoppable) {
    await store.set(IDENTITY_KEY, JSON.stringify({ id: deploymentId, ...facts, claimedAt: at(), updatedAt: at() }));
    return allowed(self, 'owner', deploymentId, `DEPLOYMENT_CLAIM=true: claimed this Redis for "${deploymentId}"${record && record.id !== deploymentId ? ` (it was "${record.id}"'s)` : ''}. Remove DEPLOYMENT_CLAIM before the next restart`);
  }

  if (record) {
    if (record.id !== deploymentId) {
      return disagree(self, record.id, `this Redis belongs to deployment "${record.id}"; this process is "${deploymentId}"`);
    }
    const moved = movedChains(record, facts);
    if (moved.length > 0 && self.stoppable) {
      return disagree(self, record.id, `the record for "${record.id}" is on other chain ids (${moved.join(', ')}): another network under the same DEPLOYMENT_ID. If this stack really moved, restart once with DEPLOYMENT_CLAIM=true`);
    }
    if (JSON.stringify([record.tier, record.chains]) !== JSON.stringify([facts.tier, facts.chains])) {
      await store.set(IDENTITY_KEY, JSON.stringify({ ...record, ...facts, updatedAt: at() }));
    }
    return allowed(self, 'owner', record.id, moved.length > 0 ? `recorded ${moved.join(', ')} for "${record.id}"` : null);
  }

  const { positive, weak } = await foreignIndexState(store, facts);
  if (self.stoppable && (positive.length > 0 || weak.length > 0)) {
    return disagree(self, null, `this Redis holds another deployment's data (${[...positive, ...weak].join('; ')}); not claiming it. If it really is this stack's own, restart once with DEPLOYMENT_CLAIM=true`);
  }
  const claim: IdentityRecord = { id: deploymentId, ...facts, claimedAt: at(), updatedAt: at() };
  if ((await store.set(IDENTITY_KEY, JSON.stringify(claim), 'NX')) === null) {
    // The key is taken: another process claimed it between the read and the
    // write, or it holds something this release cannot read. Re-reading a
    // readable record ends in the record branch above; anything else must not
    // be retried, which would loop for ever.
    if (parseRecord(await store.get(IDENTITY_KEY))) return resolveIdentity(store, self, now);
    return allowed(self, 'unknown', null, `${IDENTITY_KEY} holds a value this release cannot read, so no deployment could claim this Redis; delete it and restart`);
  }
  const noted = [...positive, ...weak];
  return allowed(self, 'owner', deploymentId, noted.length > 0 ? `claimed this Redis although it holds index state from elsewhere (${noted.join('; ')})` : null);
}

let status: IdentityStatus | null = null;
let retryTimer: NodeJS.Timeout | null = null;
const skipLogged = new Set<string>();

/** The latest result, for /health/bridge; null before the first check has answered. */
export function deploymentIdentityStatus(): IdentityStatus | null {
  return status;
}

/**
 * Whether `writer` may write shared state now. True until a check says
 * otherwise, so nothing changes for a process the check never ran in.
 */
export function backgroundWritesAllowed(writer: string): boolean {
  if (!status || status.writersAllowed) return true;
  if (!skipLogged.has(writer)) {
    skipLogged.add(writer);
    console.warn(`[identity] ${writer} skipped: ${status.reason}`);
  }
  return false;
}

function report(next: IdentityStatus, previous: IdentityStatus | null): void {
  if (previous && previous.role === next.role && previous.reason === next.reason) return;
  const who = next.deploymentId ? `"${next.deploymentId}"` : '(no DEPLOYMENT_ID)';
  if (!next.writersAllowed) {
    const line = `${who}: ${next.reason}. Background writes (indexers, sweeps, CCTP poller, agent reconcile and starts) are OFF in this process; HTTP still serves.`;
    console.error(`[identity] ⛔ ${line}`);
    Sentry.captureMessage(`deployment identity: ${line}`, 'error');
  } else if (next.reason) {
    console.warn(`[identity] ⚠ ${who}: ${next.reason}`);
    if (next.role === 'not-owner') Sentry.captureMessage(`deployment identity: ${who}: ${next.reason}`, 'warning');
  } else if (next.role === 'owner') {
    console.log(`[identity] ${who} owns this Redis`);
  }
}

/**
 * Run at boot, before the background writers start. Never throws. An
 * unanswered check (Redis down or slow) lets writes run and is retried every
 * RETRY_MS; a later answer takes effect through backgroundWritesAllowed().
 */
export async function checkDeploymentIdentity(
  timeoutMs = CHECK_TIMEOUT_MS,
  store: IdentityRedis = redis as unknown as IdentityRedis,
  self: Self = currentSelf(),
): Promise<IdentityStatus> {
  const previous = status;
  let timer: NodeJS.Timeout | undefined;
  try {
    status = await Promise.race([
      resolveIdentity(store, self),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer from Redis in ${timeoutMs / 1000}s`)), timeoutMs);
        timer.unref();
      }),
    ]);
  } catch (err) {
    status = {
      deploymentId: self.deploymentId, role: 'unknown', owner: null, writersAllowed: true,
      reason: `could not check which deployment owns this Redis (${(err as Error).message}); background writes run meanwhile and the check retries every ${RETRY_MS / 1000}s`,
    };
  } finally {
    clearTimeout(timer);
  }
  report(status, previous);
  if (status.role === 'unknown' && !retryTimer) {
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void checkDeploymentIdentity(timeoutMs, store, self);
    }, RETRY_MS);
    retryTimer.unref();
  }
  return status;
}

/** Tests only: forget the last result and any pending retry. */
export function _resetIdentityForTests(): void {
  status = null;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  skipLogged.clear();
}
