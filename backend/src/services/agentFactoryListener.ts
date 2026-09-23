/**
 * AgentFactory event listener — watches AgentDeployed events on Arc and
 * records each paid deploy as a durable, claimable credit.
 *
 *   agentfactory:credit:<user>:<nonce>  → JSON {user, nonce, amount, block, txHash, ts}
 *   agentfactory:credits:<user>         → set of nonces paid by that user
 *   agentfactory:events:checkpoint      → last block number processed
 *
 * Why a credit and not an agent: the deploy transaction carries no agent
 * configuration and, critically, no owner public key. Agent private keys are
 * ECIES-encrypted to that key, so creating the agent here is impossible —
 * `deployAgent` with an empty ownerPublicKey throws before it can persist
 * anything. Recording the credit keeps the payment accounted for; the agent is
 * created through the authenticated route, where the owner's key is known.
 *
 * Follows the checkpointing pattern in baseEscrowEvents.ts: Redis-backed
 * checkpoint, bounded chunks, single in-flight tick, and idempotent writes so
 * at-least-once delivery from the poll loop is safe across restarts.
 */
import { backgroundWritesAllowed } from './deploymentIdentity.js';
import type { EventLog } from 'ethers';
import { ethers } from 'ethers';
import { config } from '../config.js';
import { arcProvider } from './chain.js';
import { redis } from './redis.js';

const AGENT_FACTORY_ABI = [
  'event AgentDeployed(address indexed user, uint256 usdcAmount, uint256 nonce, uint256 timestamp)',
];

// ── Redis keys ──────────────────────────────────────────────────────────────

const KEY = {
  credit: (user: string, nonce: bigint | string) =>
    `agentfactory:credit:${user.toLowerCase()}:${String(nonce)}`,
  creditsByUser: (user: string) => `agentfactory:credits:${user.toLowerCase()}`,
  checkpoint: (addr: string) => `agentfactory:events:checkpoint:${addr.toLowerCase()}`,
};

// ── Polling config ──────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 15_000;
const MAX_BLOCKS_PER_TICK = 5_000;

// Indexer start block. The Arc var wins; the Base one is the legacy fallback
// for stacks that set it before the factory moved to Arc.
const DEPLOYMENT_BLOCK = Number(
  process.env.ARC_AGENT_FACTORY_DEPLOYMENT_BLOCK ?? process.env.AGENT_FACTORY_DEPLOYMENT_BLOCK ?? 0,
);

// ── State ───────────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
let inFlightPromise: Promise<void> | null = null;
let contract: ethers.Contract | null = null;

// ── Public API ──────────────────────────────────────────────────────────────

export type AgentDeployCredit = {
  user: string;
  nonce: string;
  usdcAmount: string;
  block: number;
  txHash: string;
  ts: number;
};

/** Unclaimed deploy credits paid by `user`, oldest first. */
export async function listDeployCredits(user: string): Promise<AgentDeployCredit[]> {
  const nonces = await redis.smembers(KEY.creditsByUser(user));
  if (nonces.length === 0) return [];

  const raw = await Promise.all(nonces.map((n) => redis.get(KEY.credit(user, n))));
  return raw
    .filter((r): r is string => !!r)
    .map((r) => JSON.parse(r) as AgentDeployCredit)
    .sort((a, b) => Number(a.nonce) - Number(b.nonce));
}

/**
 * Consume one credit. Returns the credit if one was claimed, null if the user
 * has none. `SREM` returning 1 is the atomic guard that makes a credit
 * single-use even under concurrent claims.
 */
/**
 * Put back a credit that was claimed for a deploy that then failed — the user
 * paid for a deploy they didn't get. Writes the same keys/shape as the indexer
 * (idempotent: SET of the same JSON + SADD of an existing member are no-ops).
 */
export async function restoreDeployCredit(credit: AgentDeployCredit): Promise<void> {
  await redis.set(KEY.credit(credit.user, credit.nonce), JSON.stringify(credit));
  await redis.sadd(KEY.creditsByUser(credit.user), credit.nonce);
}

export async function claimDeployCredit(user: string): Promise<AgentDeployCredit | null> {
  const credits = await listDeployCredits(user);
  for (const credit of credits) {
    const removed = await redis.srem(KEY.creditsByUser(user), credit.nonce);
    if (removed === 1) {
      await redis.del(KEY.credit(user, credit.nonce));
      return credit;
    }
  }
  return null;
}

export function startAgentFactoryListener(): void {
  if (timer) return;

  if (!arcProvider) {
    console.log('[agentFactory] no Arc provider — listener disabled');
    return;
  }
  if (!config.arcAgentFactoryAddress) {
    console.log('[agentFactory] ARC_AGENT_FACTORY_ADDRESS not set — listener disabled');
    return;
  }

  contract = new ethers.Contract(config.arcAgentFactoryAddress, AGENT_FACTORY_ABI, arcProvider);

  void tick();
  timer = setInterval(tick, POLL_INTERVAL_MS);
  console.log(
    `[agentFactory] polling ${config.arcAgentFactoryAddress} every ${POLL_INTERVAL_MS / 1000}s`,
  );
}

export function stopAgentFactoryListener(): void {
  if (timer) clearInterval(timer);
  timer = null;
  contract = null;
}

// ── Core poll loop ──────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  if (!backgroundWritesAllowed('AgentFactory listener')) return;
  if (inFlightPromise) return inFlightPromise;

  inFlightPromise = (async () => {
    if (!contract || !arcProvider) return;

    try {
      const addr = await contract.getAddress();
      const latest = await arcProvider.getBlockNumber();
      const checkpointKey = KEY.checkpoint(addr);
      const checkpointRaw = await redis.get(checkpointKey);

      let from: number;
      if (checkpointRaw) {
        from = Number(checkpointRaw) + 1;
      } else {
        // First boot with no checkpoint: start at the deployment block if one
        // is configured, otherwise here. Never scan from block 0.
        from = DEPLOYMENT_BLOCK > 0 ? DEPLOYMENT_BLOCK : latest;
        await redis.set(checkpointKey, String(from));
      }
      if (from > latest) return;

      const to = Math.min(latest, from + MAX_BLOCKS_PER_TICK - 1);

      const events = await contract.queryFilter(contract.filters.AgentDeployed(), from, to);

      for (const ev of events) {
        await recordCredit(ev as EventLog);
      }

      if (events.length > 0) {
        console.log(
          `[agentFactory] recorded ${events.length} deploy credit(s) (blocks ${from}..${to})`,
        );
      }

      await redis.set(checkpointKey, String(to));
    } catch (e) {
      // Leave the checkpoint where it is so the chunk is retried next tick
      // rather than skipped — a paid deploy must never be dropped.
      console.error('[agentFactory] poll error:', (e as Error).message);
    } finally {
      inFlightPromise = null;
    }
  })();

  return inFlightPromise;
}

async function recordCredit(event: EventLog): Promise<void> {
  const args = event.args;
  if (!args) return;

  const user = args.user as string | undefined;
  const nonce = args.nonce as bigint | undefined;
  if (!user || nonce === undefined) return;

  const credit: AgentDeployCredit = {
    user: user.toLowerCase(),
    nonce: String(nonce),
    usdcAmount: String(args.usdcAmount ?? 0n),
    block: event.blockNumber,
    txHash: event.transactionHash,
    ts: Number(args.timestamp ?? 0n),
  };

  // Idempotent: SET to an identical value and SADD of an existing member are
  // both no-ops, so replaying a chunk after a restart changes nothing.
  const key = KEY.credit(user, nonce);
  const existed = await redis.exists(key);

  await redis.set(key, JSON.stringify(credit));
  await redis.sadd(KEY.creditsByUser(user), credit.nonce);

  if (!existed) {
    console.log(
      `[agentFactory] deploy credit recorded: user=${credit.user} nonce=${credit.nonce} tx=${credit.txHash}`,
    );
  }
}
