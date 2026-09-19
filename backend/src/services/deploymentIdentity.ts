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
 * CCTP poller, agent reconcile and agent starts, and its running workers are
 * stopped. Each writer checks backgroundWritesAllowed() when it runs. HTTP
 * still serves. Every process re-checks every RETRY_MS, so a verdict that
 * changes (a Redis taken back, an answer after an outage) takes effect
 * without a restart.
 *
 * Production can never be stopped. Only a STOPPABLE process can: a staging
 * stack (DEPLOYMENT_SET or SETTLEMENT_TIER=testnet), anything off 0G mainnet,
 * or anything not running as NODE_ENV=production (local development, where
 * the 2026-05-25 backend ran). Production claims whatever it finds, takes the
 * record back from any other deployment, and only logs index keys that
 * disagree with it: nothing another process writes can turn it off.
 *
 * A stoppable process:
 * - with a DEPLOYMENT_ID, claims only a Redis with no other deployment's
 *   data: no record, no escrow fingerprint for an escrow it does not index,
 *   no indexer checkpoint without a fingerprint (production's history from
 *   before fingerprints). It writes nothing until that check has answered.
 *   DEPLOYMENT_CLAIM takes a Redis over on purpose, on the first check only,
 *   and only from the owner it names (or "unclaimed"), so a value left in the
 *   environment cannot take a different Redis.
 * - without one (local development), stops on a record naming other chains,
 *   or a fingerprint from another chain id. A fingerprint for another escrow
 *   on the same chain (an earlier local run) and a checkpoint with no
 *   fingerprint are only logged, with the keys to delete.
 *
 * A check that gets no answer (Redis down or slow) leaves production
 * writing — failing closed there would stop the owner on a blip — and keeps
 * a stoppable process's writes off until a check answers: whatever such a
 * process wrote meanwhile (its own fingerprints) would later vouch for a
 * claim on a Redis that is not its own. A check that timed out writes
 * nothing afterwards.
 */

import * as Sentry from '@sentry/node';
import { config } from '../config.js';
import { redis } from './redis.js';
import { settlementChainConfigs } from './settlementChains.js';
import { FINGERPRINT_KEY } from './escrowFingerprint.js';
import { TIER_CHAIN_IDS, type SettlementTier } from './settlementTier.js';

export const IDENTITY_KEY = 'deployment:identity';

/** The TaskCreated checkpoint each indexer keeps (escrowEvents.ts and baseEscrowEvents.ts KEY.checkpoint). */
export const INDEX_CHECKPOINT_KEY: Readonly<Record<keyof typeof FINGERPRINT_KEY, string>> = {
  '0g': 'a2a:events:checkpoint',
  base: 'base:events:checkpoint',
};

/** How long a check waits for Redis before letting writes run anyway. */
export const CHECK_TIMEOUT_MS = 10_000;
/** How often every process checks again. */
export const RETRY_MS = 60_000;

export interface DeploymentFacts {
  tier: SettlementTier | null;
  /** Each chain this deployment has an escrow on. */
  chains: Record<string, { chainId: number; escrow: string }>;
}

export interface IdentityRecord extends DeploymentFacts {
  id: string;
  /** false for production: its Redis is never taken over (it takes it back). */
  stoppable?: boolean;
  claimedAt: string;
  updatedAt: string;
}

/**
 * owner     — DEPLOYMENT_ID matches the record, or this process claimed it.
 * not-owner — this Redis belongs to another deployment (a production process
 *             is told so but keeps writing).
 * unset     — no DEPLOYMENT_ID and nothing against it.
 * unknown   — no answer from Redis (or an unreadable record): production
 *             keeps writing, a stoppable process does not; the next check
 *             retries.
 */
export type IdentityRole = 'owner' | 'not-owner' | 'unset' | 'unknown';

export interface IdentityStatus {
  deploymentId: string | null;
  role: IdentityRole;
  /** The recorded owner's id, when there is a record. */
  owner: string | null;
  writersAllowed: boolean;
  /** Whether this process can be stopped at all; production must say false. */
  stoppable: boolean;
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
  /** The only kind of process that can be stopped. */
  stoppable: boolean;
  /** DEPLOYMENT_CLAIM as set: the owner id to take over from, or "unclaimed". */
  claim: string | null;
}

/** A DEPLOYMENT_CLAIM that names something: an owner id, or "unclaimed". */
export function isValidClaim(claim: string): boolean {
  return !['true', 'false', 'yes', 'no', '1', '0'].includes(claim.toLowerCase()) && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(claim);
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
 * Whether this process can be stopped. Production — NODE_ENV=production on
 * 0G mainnet, the default deployment set, not a testnet tier — never can;
 * SETTLEMENT_TIER=mainnet, set at the mainnet flip, does not change that.
 */
export function isStoppable(): boolean {
  return config.deploymentSet !== ''
    || config.settlementTier === 'testnet'
    || config.nodeEnv !== 'production'
    || config.ogChainId !== TIER_CHAIN_IDS['0g'].mainnet;
}

export function currentSelf(): Self {
  return { deploymentId: config.deploymentId, facts: currentFacts(), stoppable: isStoppable(), claim: config.deploymentClaim };
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

interface Foreign {
  key: string;
  text: string;
  /** A fingerprint for another escrow on the chain id this process uses. */
  sameChain?: boolean;
}

/**
 * What in this Redis says it holds another deployment's index, every key of
 * it. `fingerprints`: fingerprints for escrows this process does not index.
 * `unvouched`: checkpoints with no fingerprint (production before
 * fingerprints). Looks at every chain's keys: the A2A queue is shared
 * whichever chains a deployment settles on.
 */
async function foreignIndexState(store: IdentityRedis, facts: DeploymentFacts): Promise<{ fingerprints: Foreign[]; unvouched: Foreign[] }> {
  const fingerprints: Foreign[] = [];
  const unvouched: Foreign[] = [];
  for (const [chain, key] of Object.entries(FINGERPRINT_KEY)) {
    const fingerprint = await store.get(key);
    const mine = facts.chains[chain];
    if (fingerprint !== null) {
      const expected = mine ? `${mine.chainId}:${mine.escrow}` : null;
      if (fingerprint !== expected) {
        fingerprints.push({
          key,
          text: `${key}=${fingerprint} (this process: ${expected ?? `no ${chain} escrow`})`,
          sameChain: !!mine && fingerprint.startsWith(`${mine.chainId}:`),
        });
      }
    } else {
      const checkpoint = INDEX_CHECKPOINT_KEY[chain as keyof typeof INDEX_CHECKPOINT_KEY];
      if ((await store.get(checkpoint)) !== null) unvouched.push({ key: checkpoint, text: `${checkpoint} with no ${key}` });
    }
  }
  return { fingerprints, unvouched };
}

const list = (found: Foreign[]) => found.map((f) => f.text).join('; ');

/**
 * Decide this process's role, claiming the Redis when it may. Pure apart from
 * `store`; checkDeploymentIdentity() wraps it with the real Redis, a timeout,
 * the periodic re-check and logging. `first`: DEPLOYMENT_CLAIM counts on a
 * process's first check only.
 */
export async function resolveIdentity(
  store: IdentityRedis,
  self: Self,
  now: () => Date = () => new Date(),
  { first = true }: { first?: boolean } = {},
): Promise<IdentityStatus> {
  const { deploymentId, facts, stoppable } = self;
  const at = now().toISOString();
  const allowed = (role: IdentityRole, owner: string | null, reason: string | null): IdentityStatus =>
    ({ deploymentId, role, owner, writersAllowed: true, stoppable, reason });
  const unknown = (reason: string): IdentityStatus => ({ deploymentId, role: 'unknown', owner: null, writersAllowed: !stoppable, stoppable, reason });
  /** Stop a stoppable process; production is told and keeps writing. */
  const disagree = (owner: string | null, reason: string): IdentityStatus => stoppable
    ? { deploymentId, role: 'not-owner', owner, writersAllowed: false, stoppable, reason }
    : { deploymentId, role: 'not-owner', owner, writersAllowed: true, stoppable, reason: `${reason}. This is production, which is never stopped; if this Redis is not production's, fix REDIS_URL` };
  const recordFor = (id: string): IdentityRecord => ({ id, ...facts, stoppable, claimedAt: at, updatedAt: at });

  const record = parseRecord(await store.get(IDENTITY_KEY));

  if (!deploymentId) {
    if (record) {
      // A record names a deployment: another escrow on a shared chain is not this process's.
      const differs = movedChains(record, facts).length > 0
        || Object.entries(facts.chains).some(([key, c]) => !record.chains[key] || record.chains[key].escrow !== c.escrow);
      return differs
        ? disagree(record.id, `this Redis belongs to deployment "${record.id}" (${Object.entries(record.chains).map(([k, c]) => `${k} ${c.chainId}`).join(', ')}), whose chains are not this process's; give this process its own REDIS_URL`)
        : allowed('unset', record.id, null);
    }
    const { fingerprints, unvouched } = await foreignIndexState(store, facts);
    const otherChain = fingerprints.filter((f) => !f.sameChain);
    const keys = [...fingerprints, ...unvouched].map((f) => f.key).join(', ');
    if (otherChain.length > 0) {
      return disagree(null, `this Redis holds another network's index (${list(otherChain)}); give this process its own REDIS_URL. If this Redis really is this process's own, delete ${keys} and restart`);
    }
    const noted = [...fingerprints, ...unvouched];
    return allowed('unset', null, noted.length > 0 ? `this Redis has index state this process cannot vouch for (${list(noted)}); if it is left from an earlier run, delete ${keys}` : null);
  }

  // DEPLOYMENT_CLAIM: on purpose, once, and only from the owner it names.
  let claimNote: string | null = null;
  if (stoppable && self.claim && !isValidClaim(self.claim)) {
    claimNote = `DEPLOYMENT_CLAIM=${self.claim} ignored: it must name the owner it replaces (/health/bridge deploymentIdentity.owner) or "unclaimed"`;
  } else if (stoppable && self.claim && first && record?.stoppable === false) {
    claimNote = `DEPLOYMENT_CLAIM=${self.claim} ignored: "${record.id}" is production, whose Redis is never taken over (it takes it back)`;
  } else if (stoppable && self.claim && first) {
    const named = self.claim === 'unclaimed' ? record === null : record?.id === self.claim;
    if (named) {
      await store.set(IDENTITY_KEY, JSON.stringify(recordFor(deploymentId)));
      return allowed('owner', deploymentId, `DEPLOYMENT_CLAIM=${self.claim}: claimed this Redis for "${deploymentId}"${record && record.id !== deploymentId ? ` (it was "${record.id}"'s)` : ''}. Remove DEPLOYMENT_CLAIM before the next restart`);
    }
    claimNote = `DEPLOYMENT_CLAIM=${self.claim} ignored: this Redis is ${record ? `"${record.id}"'s` : 'unclaimed'}, not what it names`;
  }
  const withNote = (s: IdentityStatus): IdentityStatus => (claimNote ? { ...s, reason: s.reason ? `${s.reason}. ${claimNote}` : claimNote } : s);

  if (record) {
    if (record.id !== deploymentId) {
      if (!stoppable) {
        // Production's Redis, whatever wrote the record.
        await store.set(IDENTITY_KEY, JSON.stringify(recordFor(deploymentId)));
        return allowed('owner', deploymentId, `took this Redis back from deployment "${record.id}"; that deployment's processes stop at their next check`);
      }
      return withNote(disagree(record.id, `this Redis belongs to deployment "${record.id}"; this process is "${deploymentId}"`));
    }
    const moved = movedChains(record, facts);
    if (moved.length > 0 && stoppable) {
      return withNote(disagree(record.id, `the record for "${record.id}" is on other chain ids (${moved.join(', ')}): another network under the same DEPLOYMENT_ID. If this stack really moved, restart once with DEPLOYMENT_CLAIM=${record.id}`));
    }
    if (JSON.stringify([record.tier, record.chains, record.stoppable]) !== JSON.stringify([facts.tier, facts.chains, stoppable])) {
      await store.set(IDENTITY_KEY, JSON.stringify({ ...record, ...facts, stoppable, updatedAt: at }));
    }
    return withNote(allowed('owner', record.id, moved.length > 0 ? `recorded ${moved.join(', ')} for "${record.id}"` : null));
  }

  const { fingerprints, unvouched } = await foreignIndexState(store, facts);
  if (stoppable && fingerprints.length > 0) {
    return withNote(disagree(null, `this Redis holds another deployment's index (${list([...fingerprints, ...unvouched])}); not claiming it. If it really is this stack's own (an escrow it redeployed, say), restart once with DEPLOYMENT_CLAIM=unclaimed`));
  }
  if (stoppable && unvouched.length > 0) {
    // A stack on this release fingerprints before it checkpoints, so bare
    // checkpoints come from a backend that predates identity checks.
    return withNote(disagree(null, `this looks like production's Redis from before identity checks (${list(unvouched)}): check REDIS_URL, and do not claim it`));
  }
  if ((await store.set(IDENTITY_KEY, JSON.stringify(recordFor(deploymentId)), 'NX')) === null) {
    // The key is taken: another process claimed it between the read and the
    // write, or it holds something this release cannot read. Re-reading a
    // readable record ends in the record branch above; anything else must not
    // be retried, which would loop for ever.
    if (parseRecord(await store.get(IDENTITY_KEY))) return resolveIdentity(store, self, now, { first });
    return unknown(`${IDENTITY_KEY} holds a value this release cannot read, so no deployment could claim this Redis; delete it and restart`);
  }
  const reason = fingerprints.length > 0
    ? `claimed this Redis although it holds index state from elsewhere (${list(fingerprints)})`
    : unvouched.length > 0 ? `claimed this Redis, taking its unfingerprinted index state as this deployment's own history (${list(unvouched)})` : null;
  return allowed('owner', deploymentId, reason);
}

let status: IdentityStatus | null = null;
/** Set while a stoppable process's FIRST check is in flight: it writes nothing until it answers. */
let firstCheckPending = false;
/** Whether any check has read Redis: DEPLOYMENT_CLAIM counts until one has. */
let answeredOnce = false;
let recheckTimer: NodeJS.Timeout | null = null;
const skipLogged = new Set<string>();
const stopListeners: Array<(status: IdentityStatus) => void> = [];

/** The latest result, for /health/bridge; null before the first check has answered. */
export function deploymentIdentityStatus(): IdentityStatus | null {
  return status;
}

/**
 * Whether `writer` may write shared state now. A stoppable process waits for
 * its first check; anything else writes until a check says otherwise, so
 * nothing changes for a process the check never ran in.
 */
export function backgroundWritesAllowed(writer: string): boolean {
  if (status ? status.writersAllowed : !firstCheckPending) return true;
  if (!skipLogged.has(writer)) {
    skipLogged.add(writer);
    console.warn(`[identity] ${writer} skipped: ${status?.reason ?? 'waiting for the check of which deployment owns this Redis'}`);
  }
  return false;
}

/** Called once each time this process's writes turn off (agentRunner stops its workers). */
export function onBackgroundWritesStopped(listener: (status: IdentityStatus) => void): void {
  stopListeners.push(listener);
}

function report(next: IdentityStatus, previous: IdentityStatus | null): void {
  if (previous && previous.role === next.role && previous.reason === next.reason) return;
  const who = next.deploymentId ? `"${next.deploymentId}"` : '(no DEPLOYMENT_ID)';
  if (!next.writersAllowed) {
    const line = `${who}: ${next.reason}. Background writes (indexers, sweeps, CCTP poller, agent reconcile, starts and running workers) are OFF in this process; HTTP still serves.`;
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
 * Run at boot, before the background writers start, and again every
 * RETRY_MS. Never throws. A check that gets no answer lets writes run.
 */
export async function checkDeploymentIdentity(
  timeoutMs = CHECK_TIMEOUT_MS,
  store: IdentityRedis = redis as unknown as IdentityRedis,
  self: Self = currentSelf(),
): Promise<IdentityStatus> {
  const previous = status;
  const first = !answeredOnce;
  if (status === null && self.stoppable) firstCheckPending = true;
  // A check that gave up must not claim or rewrite anything when Redis answers later.
  let abandoned = false;
  const guarded: IdentityRedis = {
    get: (key) => store.get(key),
    set: (key, value, mode) => (abandoned ? Promise.reject(new Error('identity check abandoned')) : store.set(key, value, mode)),
  };
  let timer: NodeJS.Timeout | undefined;
  const attempt = resolveIdentity(guarded, self, undefined, { first });
  attempt.catch(() => {}); // settled late after a timeout: nothing to report
  try {
    status = await Promise.race([
      attempt,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { abandoned = true; reject(new Error(`no answer from Redis in ${timeoutMs / 1000}s`)); }, timeoutMs);
        timer.unref();
      }),
    ]);
    answeredOnce = true;
  } catch (err) {
    abandoned = true;
    status = {
      deploymentId: self.deploymentId, role: 'unknown', owner: null, writersAllowed: !self.stoppable, stoppable: self.stoppable,
      reason: `could not check which deployment owns this Redis (${(err as Error).message}); ${self.stoppable ? 'background writes stay off until a check answers' : 'background writes run meanwhile'}, and the check retries every ${RETRY_MS / 1000}s`,
    };
  } finally {
    clearTimeout(timer);
    firstCheckPending = false;
  }
  report(status, previous);
  if ((previous ? previous.writersAllowed : true) && !status.writersAllowed) {
    for (const listener of stopListeners) {
      try { listener(status); } catch (err) { console.error('[identity] stop listener failed:', (err as Error).message); }
    }
  }
  if (!recheckTimer) {
    recheckTimer = setTimeout(() => {
      recheckTimer = null;
      void checkDeploymentIdentity(timeoutMs, store, self);
    }, RETRY_MS);
    recheckTimer.unref();
  }
  return status;
}

/** Tests only: forget every result, listener and pending re-check. */
export function _resetIdentityForTests(): void {
  status = null;
  firstCheckPending = false;
  answeredOnce = false;
  if (recheckTimer) clearTimeout(recheckTimer);
  recheckTimer = null;
  skipLogged.clear();
  stopListeners.length = 0;
}
