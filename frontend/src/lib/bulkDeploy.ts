/**
 * Deploying one or several hosted agents from the web form. Every agent goes
 * through POST /api/v1/agents/deploy on its own, so each passes the same
 * checks, fee, worker limit and audit trail as a single deploy; this only
 * runs them one after another.
 *
 * Its I/O is injected (the page wires the real API and wallet), so these
 * money rules are tested without either:
 * - nothing starts past the worker limit: a run asking for more agents than
 *   GET /agents/capacity has free is refused before anything is paid;
 * - each agent pays its own deploy fee, once. A transfer is saved to the
 *   pending fees the moment the wallet broadcasts it, and that hash alone is
 *   cleared when its agent exists, so a failure (a closed tab included) never
 *   makes the next attempt pay again and another tab's saved fee is never
 *   touched (lib/pendingFees.ts); a payment saved by an earlier attempt pays
 *   for the first agent of this run;
 * - a 429 is refused by the rate limiter before the route runs: nothing was
 *   created and nothing was claimed, so the same request, with the fee that
 *   agent already paid, is sent again after a wait (2, 4, 8, 16, 32 s);
 * - an agent's wallet is funded only after that agent's deploy succeeded,
 *   never for one that failed or did not start;
 * - the first failure stops the run (a funding failure, and an agent that
 *   was created but did not start, too): agents already deployed stay and are
 *   listed, the rest are skipped.
 */
import { agentFundingAddress, type SettlementChainInfo } from '../config/settlement';

/** The most agents one run deploys. */
export const MAX_AGENTS_PER_RUN = 10;
/** The longest agent name POST /agents/deploy takes (backend DeploySchema). */
export const MAX_AGENT_NAME = 80;
/** Waits before each retry of a rate-limited deploy: 6 attempts in all. */
export const RATE_LIMIT_BACKOFF_MS = [2_000, 4_000, 8_000, 16_000, 32_000];
/** Between the deploy retries that wait for a fee to be seen (the existing form's rule). */
export const FEE_RETRY_MS = 5_000;

/**
 * The names a run deploys: `{n}` in the name becomes each agent's number,
 * from 1; otherwise one agent keeps the name and several get " 1", " 2", ….
 */
export function agentNames(name: string, count: number): string[] {
  const base = name.trim();
  return Array.from({ length: count }, (_, i) => {
    const n = String(i + 1);
    if (base.includes('{n}')) return base.split('{n}').join(n);
    return count === 1 ? base : `${base} ${n}`;
  });
}

/** What is wrong with these names for POST /agents/deploy, or null. */
export function namesProblem(names: string[]): string | null {
  if (names.length === 0 || names.some((n) => n.length === 0)) return 'Give the agent a name.';
  const long = names.find((n) => n.length > MAX_AGENT_NAME);
  if (long) return `"${long}" is ${long.length} characters; a name can be at most ${MAX_AGENT_NAME}. Shorten the name.`;
  return null;
}

/**
 * GET /api/v1/agents/capacity: worker slots on the backend process that
 * answered, the owner's share of them, and how many more its memory allows
 * (null where it isn't measured; absent from older backends).
 */
export interface AgentCapacity {
  poolMax: number;
  poolFree: number;
  ownerMax: number;
  ownerFree: number;
  memory?: { availableMb: number; reserveMb: number; workerMb: number; slotsFree: number; source: string } | null;
  canStart: boolean;
  scope?: string;
}

/** How many more agents this owner can start now, or null when unknown. */
export function freeSlots(capacity: AgentCapacity | null | undefined): number | null {
  if (!capacity) return null;
  return Math.max(0, Math.min(capacity.poolFree, capacity.ownerFree, capacity.memory?.slotsFree ?? Number.POSITIVE_INFINITY));
}

/** The most agents the form offers: the run limit, capped by the free slots when known. */
export function maxDeployable(capacity: AgentCapacity | null | undefined): number {
  const free = freeSlots(capacity);
  return free === null ? MAX_AGENTS_PER_RUN : Math.min(MAX_AGENTS_PER_RUN, free);
}

/**
 * Whether `requested` agents can start now. When they can't, `free` is how
 * many can, and `message` says so in plain words.
 */
export function capacityCheck(requested: number, capacity: AgentCapacity | null | undefined):
  | { ok: true }
  | { ok: false; free: number; message: string } {
  const free = freeSlots(capacity);
  if (free === null || requested <= free) return { ok: true };
  const c = capacity!;
  const why = c.memory && c.memory.slotsFree === free && free < Math.min(c.poolFree, c.ownerFree)
    ? 'the server is low on memory'
    : c.poolFree < c.ownerFree
      ? 'the server has no more free worker slots'
      : `you can run ${c.ownerMax} agents at once`;
  return {
    ok: false,
    free,
    message: free === 0
      ? `No agent can start now: ${why}. Stop one of your agents first. Nothing was paid.`
      : `Only ${free} of ${requested} agents can start now: ${why}. Nothing was paid.`,
  };
}

/** A run asked for more agents than can start. Thrown before anything is paid. */
export class CapacityError extends Error {
  constructor(public free: number, message: string) {
    super(message);
    this.name = 'CapacityError';
  }
}

/** A refusal from the rate limiter (HTTP 429): sent again after a wait. */
export function isRateLimited(err: unknown): boolean {
  const e = err as { status?: unknown; code?: unknown } | null;
  return e?.status === 429 || e?.code === 'RATE_LIMIT';
}

/** Whether a failed deploy means the saved payment can never pay for one. */
export function feeIsSpent(err: { code?: string; payload?: Record<string, unknown> }): boolean {
  if (['DEPLOY_FEE_ALREADY_USED', 'DEPLOY_FEE_REVERTED', 'TX_REVERTED', 'TX_CANCELLED'].includes(err.code ?? '')) return true;
  // Paid from a wallet that isn't on the account: linking it makes the same payment count.
  return err.code === 'DEPLOY_FEE_NOT_PAID' && err.payload?.reason !== 'PAYER_NOT_LINKED';
}

/** What POST /agents/deploy answers, as far as the form reads it. */
export interface DeployedAgent {
  id: string;
  started?: boolean;
  walletAddress?: string;
  smartAccountAddress?: string;
}

export type AgentRunState = 'queued' | 'paying' | 'deploying' | 'funding' | 'done' | 'failed' | 'skipped';

/** One agent of a run, as the page shows it. */
export interface AgentRun {
  name: string;
  state: AgentRunState;
  id?: string;
  walletAddress?: string;
  /** Set once deployed: false when it was created but did not start. */
  started?: boolean;
  /** The transaction that paid its deploy fee (a transfer, or the AgentFactory payment). */
  feeTx?: string;
  /** The transaction that funded its wallet. */
  fundTx?: string;
  /** Why it failed (state 'failed'). */
  error?: unknown;
  /** Why funding its wallet failed: it is deployed, and the run stopped there. */
  fundError?: unknown;
}

export interface DeployDeps {
  /**
   * Pay one deploy fee as a transfer. `onBroadcast` gets the hash the moment
   * the wallet broadcasts it, before any wait. Returns the hash.
   */
  payTransfer: (onBroadcast: (hash: string) => void) => Promise<string>;
  /** Pay one deploy fee through AgentFactory; its event becomes a credit. Returns the factory transaction's hash. */
  payFactory: () => Promise<string>;
  /** POST /api/v1/agents/deploy. Throws the API error (code, status, payload). */
  deploy: (body: Record<string, unknown>) => Promise<DeployedAgent>;
  /** Send `to` the funding amount. Returns the transaction hash. */
  fund: (to: string) => Promise<string>;
  /** Save a transfer no deploy has used yet, the moment the wallet broadcasts it. */
  savePendingFee: (hash: string) => void;
  /** Forget this saved transfer and no other: a deploy used it, or it can never pay for one. */
  clearPendingFee: (hash: string) => void;
  sleep: (ms: number) => Promise<void>;
  /** Called with every change to an agent of the run. */
  onUpdate?: (index: number, agent: AgentRun) => void;
}

export interface DeployRun {
  names: string[];
  /** The deploy request every agent shares, without its name. */
  body: Record<string, unknown>;
  /** How the deploy fee is paid: not at all, one transfer per agent, or one AgentFactory payment per agent. */
  fee: 'none' | 'transfer' | 'factory';
  /** A transfer an earlier attempt paid that no deploy used: it pays for the first agent. */
  savedFee?: string | null;
  /** Fund each agent's wallet after it deploys, on this chain (its smart account where the chain's escrow records one, else its EOA). */
  fundOn?: SettlementChainInfo | null;
  /** Free worker slots when known: a run asking for more is refused before anything is paid. */
  free?: number | null;
}

export interface DeployOutcome {
  agents: AgentRun[];
  /** Where the run stopped, or null when every agent deployed (and was funded, if asked). */
  stoppedAt: number | null;
}

/** POST /deploy for one agent, asking again while the backend says to: a fee not seen yet, or a rate limit. */
async function deployWithRetries(deps: DeployDeps, body: Record<string, unknown>, fee: DeployRun['fee']): Promise<DeployedAgent> {
  const feeTxHash = body.feeTxHash as string | undefined;
  // Factory: the AgentFactory listener polls every 15s, so the credit can lag
  // the payment by up to a minute. Arc: the backend already asks Arc for the
  // fee's receipt several times; a lagging RPC gets two more tries.
  const maxAttempts = feeTxHash ? 3 : fee === 'factory' ? 20 : 1;
  const retryCode = feeTxHash ? 'DEPLOY_FEE_NOT_FOUND' : 'NO_DEPLOY_CREDIT';
  let attempt = 0;
  let limited = 0;
  for (;;) {
    try {
      return await deps.deploy(body);
    } catch (err) {
      if (isRateLimited(err) && limited < RATE_LIMIT_BACKOFF_MS.length) {
        await deps.sleep(RATE_LIMIT_BACKOFF_MS[limited++]);
        continue;
      }
      if ((err as { code?: string })?.code === retryCode && attempt < maxAttempts - 1) {
        attempt++;
        await deps.sleep(FEE_RETRY_MS);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Deploy `run.names.length` agents, one after another. Throws CapacityError,
 * before anything is paid, when more are asked for than `run.free`.
 */
export async function runDeploys(run: DeployRun, deps: DeployDeps): Promise<DeployOutcome> {
  if (run.free !== undefined && run.free !== null && run.names.length > run.free) {
    throw new CapacityError(run.free, `Only ${run.free} of ${run.names.length} agents can start now. Nothing was paid.`);
  }
  const agents: AgentRun[] = run.names.map((name) => ({ name, state: 'queued' }));
  const update = (i: number, patch: Partial<AgentRun>) => {
    agents[i] = { ...agents[i], ...patch };
    deps.onUpdate?.(i, agents[i]);
  };
  let saved = run.fee === 'transfer' ? run.savedFee ?? null : null;

  for (let i = 0; i < agents.length; i++) {
    let feeTx: string | undefined;
    try {
      if (run.fee === 'transfer') {
        if (saved) {
          // An earlier attempt's payment: this agent uses it, with no new charge.
          feeTx = saved;
          saved = null;
        } else {
          update(i, { state: 'paying' });
          feeTx = await deps.payTransfer((hash) => {
            feeTx = hash;
            deps.savePendingFee(hash);
          });
        }
      } else if (run.fee === 'factory') {
        update(i, { state: 'paying' });
        feeTx = await deps.payFactory();
      }
      update(i, { state: 'deploying', ...(feeTx ? { feeTx } : {}) });
      const body = { ...run.body, name: agents[i].name, ...(run.fee === 'transfer' && feeTx ? { feeTxHash: feeTx } : {}) };
      const agent = await deployWithRetries(deps, body, run.fee);
      // The payment made this agent: it can never pay for another.
      if (run.fee === 'transfer' && feeTx) deps.clearPendingFee(feeTx);
      const started = agent.started === true;
      update(i, { state: 'done', id: agent.id, walletAddress: agent.walletAddress, started });
      // Created but not running: the next ones would likely not start either.
      if (!started) return finish(agents, i);

      if (run.fundOn) {
        const to = agentFundingAddress(agent, run.fundOn);
        update(i, { state: 'funding' });
        try {
          if (!to) throw new Error('The backend did not return this agent\'s wallet, so it could not be funded.');
          update(i, { state: 'done', fundTx: await deps.fund(to) });
        } catch (fundErr) {
          update(i, { state: 'done', fundError: fundErr });
          return finish(agents, i);
        }
      }
    } catch (err) {
      // A payment that can never pay for a deploy is forgotten, so the next attempt pays anew.
      if (run.fee === 'transfer' && feeTx && feeIsSpent((err ?? {}) as { code?: string })) deps.clearPendingFee(feeTx);
      update(i, { state: 'failed', error: err, ...(feeTx ? { feeTx } : {}) });
      return finish(agents, i);
    }
  }
  return { agents, stoppedAt: null };

  function finish(list: AgentRun[], at: number): DeployOutcome {
    for (let j = at + 1; j < list.length; j++) update(j, { state: 'skipped' });
    return { agents: list, stoppedAt: at };
  }
}
