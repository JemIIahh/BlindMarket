/**
 * Which deployment owns this Redis, and whether this process may run its
 * background writers.
 *
 * A2A keys are not namespaced by chain or deployment, so every backend on a
 * Redis reads and writes the same queue and index. On 2026-05-25 a local
 * testnet backend pointed at production's Redis poached a mainnet task. A
 * staging stack gets its own Redis; this is the tripwire for when one does not.
 *
 * A deployment names itself with DEPLOYMENT_ID. The first process with an id
 * to reach a Redis that shows no other deployment's data claims it, writing
 * IDENTITY_KEY = {id, tier, chains}. A process whose id differs from the
 * recorded owner is the one that disagrees: it keeps serving HTTP but starts
 * none of its background writers (indexers, the expiry sweep, the CCTP poller,
 * agent reconcile), so it cannot rewrite the owner's index, re-open its tasks,
 * or fork agents onto its queue. The owner is never stopped.
 *
 * Evidence that an unclaimed Redis belongs to someone else:
 * - an escrow fingerprint (escrowFingerprint.ts) for an escrow this process
 *   does not index, which only a deployment of this release writes;
 * - for a STRICT process (SETTLEMENT_TIER or a non-default DEPLOYMENT_SET is
 *   set, as on a staging stack), indexer checkpoints with no fingerprint:
 *   production from before this release, whose Redis a misconfigured staging
 *   stack must not claim. A process that is not strict takes them as its own
 *   history, which is how production's first boot of this release claims its
 *   Redis. Production sets neither until the mainnet launch.
 *
 * A process without DEPLOYMENT_ID (production until it sets one, local
 * development) never claims and is never stopped; a record that disagrees
 * with it is only logged. A Redis error leaves the writers on, as they were
 * before this check: failing closed would stop the owner on a blip.
 */

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

/** How long boot waits for Redis before starting the writers anyway. */
const CHECK_TIMEOUT_MS = 10_000;

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
 * owner     — DEPLOYMENT_ID matches the record, or this process just claimed it.
 * not-owner — DEPLOYMENT_ID is set and the Redis belongs to another deployment.
 * unset     — no DEPLOYMENT_ID: never claims, never stopped.
 * unknown   — the check could not read Redis; writers run.
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

/** This process's facts, from the settlement registry. */
export function currentFacts(): DeploymentFacts {
  const chains: DeploymentFacts['chains'] = {};
  for (const entry of settlementChainConfigs()) {
    if (entry.escrowAddress) chains[entry.key] = { chainId: entry.chainId, escrow: entry.escrowAddress.toLowerCase() };
  }
  return { tier: config.settlementTier, chains };
}

/** A staging-style stack: it refuses to claim a Redis whose history it cannot explain. */
export function isStrict(): boolean {
  return config.settlementTier !== null || config.deploymentSet !== '';
}

function parseRecord(raw: string | null): IdentityRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as IdentityRecord;
    return parsed && typeof parsed.id === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

const chainIdsOf = (facts: DeploymentFacts) =>
  JSON.stringify(Object.entries(facts.chains).map(([key, c]) => [key, c.chainId]).sort());
const escrowsOf = (facts: DeploymentFacts) =>
  JSON.stringify(Object.entries(facts.chains).map(([key, c]) => [key, c.escrow]).sort());

/**
 * Why the index keys in this Redis are not this process's, or null. Looks at
 * every chain's keys, not only the chains this process settles on: the A2A
 * queue is shared whichever chains a deployment uses.
 */
async function foreignIndexState(
  store: IdentityRedis,
  facts: DeploymentFacts,
  strict: boolean,
): Promise<{ key: string; why: string } | null> {
  for (const [chain, key] of Object.entries(FINGERPRINT_KEY)) {
    const fingerprint = await store.get(key);
    const mine = facts.chains[chain];
    if (fingerprint !== null) {
      const expected = mine ? `${mine.chainId}:${mine.escrow}` : null;
      if (fingerprint !== expected) {
        return { key, why: `${key} is ${fingerprint}, an escrow this process does not index (${expected ?? `no ${chain} escrow here`})` };
      }
    } else {
      const checkpoint = INDEX_CHECKPOINT_KEY[chain as keyof typeof INDEX_CHECKPOINT_KEY];
      if (strict && (await store.get(checkpoint)) !== null) {
        return { key: checkpoint, why: `${checkpoint} is set with no escrow fingerprint: indexer state from a deployment that predates fingerprints` };
      }
    }
  }
  return null;
}

/**
 * Decide this process's role, claiming the Redis when it is free. Pure apart
 * from `store`; checkDeploymentIdentity() wraps it with the real Redis, a
 * timeout and logging.
 */
export async function resolveIdentity(
  store: IdentityRedis,
  deploymentId: string | null,
  facts: DeploymentFacts,
  strict: boolean,
  now: () => Date = () => new Date(),
): Promise<IdentityStatus> {
  const record = parseRecord(await store.get(IDENTITY_KEY));

  if (!deploymentId) {
    const reason = record && chainIdsOf(record) !== chainIdsOf(facts)
      ? `this Redis belongs to deployment "${record.id}", whose chains differ from this process's; set DEPLOYMENT_ID, or give this process its own Redis`
      : null;
    return { deploymentId: null, role: 'unset', owner: record?.id ?? null, writersAllowed: true, reason };
  }

  if (record) {
    if (record.id !== deploymentId) {
      return {
        deploymentId, role: 'not-owner', owner: record.id, writersAllowed: false,
        reason: `this Redis belongs to deployment "${record.id}"; this process is "${deploymentId}"`,
      };
    }
    // The owner. Record a redeployed escrow; never adopt another network's
    // chain ids, which means two deployments share one DEPLOYMENT_ID.
    if (chainIdsOf(record) !== chainIdsOf(facts)) {
      return {
        deploymentId, role: 'owner', owner: record.id, writersAllowed: true,
        reason: `the record for "${record.id}" lists other chain ids than this process; two deployments may share this DEPLOYMENT_ID. The record was left as it is.`,
      };
    }
    if (escrowsOf(record) !== escrowsOf(facts) || record.tier !== facts.tier) {
      await store.set(IDENTITY_KEY, JSON.stringify({ ...record, ...facts, updatedAt: now().toISOString() }));
    }
    return { deploymentId, role: 'owner', owner: record.id, writersAllowed: true, reason: null };
  }

  const foreign = await foreignIndexState(store, facts, strict);
  if (foreign) {
    return {
      deploymentId, role: 'not-owner', owner: null, writersAllowed: false,
      reason: `this Redis holds another deployment's data (${foreign.why}); not claiming it. If it really is this deployment's own (an escrow it redeployed, say), delete ${foreign.key} and restart`,
    };
  }
  const at = now().toISOString();
  const claim: IdentityRecord = { id: deploymentId, ...facts, claimedAt: at, updatedAt: at };
  if ((await store.set(IDENTITY_KEY, JSON.stringify(claim), 'NX')) === null) {
    // The key is taken: another process claimed it between the read and the
    // write, or it holds something this release cannot read. Re-reading a
    // readable record ends in the record branch above; anything else must not
    // be retried, which would loop for ever.
    if (parseRecord(await store.get(IDENTITY_KEY))) return resolveIdentity(store, deploymentId, facts, strict, now);
    return {
      deploymentId, role: 'unknown', owner: null, writersAllowed: true,
      reason: `${IDENTITY_KEY} holds a value this release cannot read, so no deployment could claim this Redis; delete it and restart`,
    };
  }
  return { deploymentId, role: 'owner', owner: deploymentId, writersAllowed: true, reason: null };
}

let status: IdentityStatus | null = null;

/** The boot-time result, for /health/bridge; null before the check has run. */
export function deploymentIdentityStatus(): IdentityStatus | null {
  return status;
}

/**
 * Run once at boot, before the background writers start. Never throws.
 */
export async function checkDeploymentIdentity(timeoutMs = CHECK_TIMEOUT_MS): Promise<IdentityStatus> {
  const deploymentId = config.deploymentId;
  try {
    status = await Promise.race([
      resolveIdentity(redis as unknown as IdentityRedis, deploymentId, currentFacts(), isStrict()),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no answer from Redis in ${timeoutMs / 1000}s`)), timeoutMs).unref()),
    ]);
  } catch (err) {
    status = {
      deploymentId, role: 'unknown', owner: null, writersAllowed: true,
      reason: `could not check which deployment owns this Redis (${(err as Error).message}); background writers run as before`,
    };
  }
  const who = deploymentId ? `"${deploymentId}"` : '(no DEPLOYMENT_ID)';
  if (!status.writersAllowed) {
    console.error(`[identity] ⛔ ${who}: ${status.reason}. Background writers (indexers, sweeps, CCTP poller, agent reconcile) are OFF in this process; HTTP still serves. Give it its own REDIS_URL.`);
  } else if (status.reason) {
    console.warn(`[identity] ⚠ ${who}: ${status.reason}`);
  } else if (status.role === 'owner') {
    console.log(`[identity] ${who} owns this Redis`);
  }
  return status;
}
