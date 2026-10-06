import { describe, expect, it } from 'vitest';
import {
  agentNames, namesProblem, freeSlots, maxDeployable, capacityCheck, runDeploys, isRateLimited,
  CapacityError, MAX_AGENTS_PER_RUN, RATE_LIMIT_BACKOFF_MS,
  type AgentCapacity, type DeployDeps, type DeployRun, type DeployedAgent,
} from './bulkDeploy';
import { defaultSettlement } from '../config/settlement';

const ARC = defaultSettlement().chains.arc;
const TX = (n: number) => '0x' + n.toString(16).padStart(64, '0');
const WALLET = (n: number) => '0x' + n.toString(16).padStart(40, '0');

/** An API error the way lib/api.ts throws one. */
const apiError = (code: string, status: number, payload?: Record<string, unknown>) =>
  Object.assign(new Error(code), { code, status, payload });

const capacity = (over: Partial<AgentCapacity> = {}): AgentCapacity => ({
  poolMax: 5, poolFree: 5, ownerMax: 10, ownerFree: 10, canStart: true, scope: 'process', ...over,
});

/**
 * Deps that succeed, recording every call in order. Override what a test
 * needs; `deploy` may hand a request on to `ok`, the recording deploy.
 */
function makeDeps(over: Partial<Omit<DeployDeps, 'deploy'>> & {
  deploy?: (body: Record<string, unknown>, ok: (body: Record<string, unknown>) => Promise<DeployedAgent>) => Promise<DeployedAgent>;
} = {}) {
  const calls: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const sleeps: number[] = [];
  const slot: string[] = [];
  const cleared: string[] = [];
  let fees = 0;
  let funds = 0;
  let agentsMade = 0;
  const ok = async (body: Record<string, unknown>): Promise<DeployedAgent> => {
    bodies.push(body);
    calls.push(`deploy ${body.name}${body.feeTxHash ? ` fee ${String(body.feeTxHash).slice(-2)}` : ''}`);
    const n = ++agentsMade;
    return { id: `agent-${n}`, started: true, walletAddress: WALLET(n) };
  };
  const { deploy, ...rest } = over;
  const deps: DeployDeps = {
    payTransfer: async (onBroadcast) => {
      const hash = TX(++fees);
      calls.push(`pay ${hash.slice(-2)}`);
      onBroadcast(hash);
      return hash;
    },
    payFactory: async () => {
      const hash = TX(100 + ++fees);
      calls.push('factory');
      return hash;
    },
    deploy: (body) => (deploy ? deploy(body, ok) : ok(body)),
    fund: async (to) => {
      calls.push(`fund ${to.slice(-2)}`);
      return TX(200 + ++funds);
    },
    savePendingFee: (hash) => { slot.push(hash); calls.push(`slot ${hash.slice(-2)}`); },
    clearPendingFee: (hash) => { cleared.push(hash); calls.push(`clear ${hash.slice(-2)}`); },
    sleep: async (ms) => { sleeps.push(ms); },
    ...rest,
  };
  return { deps, calls, bodies, sleeps, slot, cleared, counts: () => ({ fees, funds, agentsMade }) };
}

const run = (over: Partial<DeployRun> = {}): DeployRun => ({
  names: agentNames('bot', 3),
  body: { provider: 'openai', model: 'gpt-x', instructions: 'do things', ownerPublicKey: '04ab' },
  fee: 'none',
  ...over,
});

describe('agentNames', () => {
  it('numbers several agents after the name, from 1', () => {
    expect(agentNames('research-agent', 3)).toEqual(['research-agent 1', 'research-agent 2', 'research-agent 3']);
  });

  it('puts the number where {n} is, every time it appears', () => {
    expect(agentNames('bot-{n}-eu', 2)).toEqual(['bot-1-eu', 'bot-2-eu']);
    expect(agentNames('{n}/{n}', 2)).toEqual(['1/1', '2/2']);
  });

  it('leaves one agent\'s name as typed (trimmed), so a single deploy is unchanged', () => {
    expect(agentNames('  research-agent ', 1)).toEqual(['research-agent']);
    expect(agentNames('bot {n}', 1)).toEqual(['bot 1']);
  });

  it('refuses a name the deploy would refuse, naming it', () => {
    expect(namesProblem(agentNames('a'.repeat(80), 1))).toBeNull();
    // 79 characters + " 10" is 82.
    const problem = namesProblem(agentNames('a'.repeat(79), 10));
    expect(problem).toContain('at most 80');
    expect(problem).toContain(`${'a'.repeat(79)} 1"`);
    expect(namesProblem(agentNames('   ', 1))).toBe('Give the agent a name.');
  });
});

describe('capacity', () => {
  it('is the smaller of the free pool and the owner\'s share, or unknown', () => {
    expect(freeSlots(capacity({ poolFree: 2, ownerFree: 7 }))).toBe(2);
    expect(freeSlots(capacity({ poolFree: 4, ownerFree: 1 }))).toBe(1);
    expect(freeSlots(null)).toBeNull();
    expect(maxDeployable(null)).toBe(MAX_AGENTS_PER_RUN);
    expect(maxDeployable(capacity({ poolFree: 3 }))).toBe(3);
    expect(maxDeployable(capacity({ poolFree: 50, ownerFree: 50 }))).toBe(MAX_AGENTS_PER_RUN);
  });

  it('counts what the server\'s memory allows, and says when that is what binds', () => {
    const memory = (slotsFree: number) => ({ availableMb: 2400, reserveMb: 2048, workerMb: 150, slotsFree, source: 'os' });
    expect(freeSlots(capacity({ poolFree: 9, ownerFree: 9, memory: memory(2) }))).toBe(2);
    expect(freeSlots(capacity({ poolFree: 1, ownerFree: 9, memory: memory(2) }))).toBe(1);
    expect(freeSlots(capacity({ poolFree: 9, ownerFree: 9, memory: null }))).toBe(9);
    expect(maxDeployable(capacity({ poolFree: 9, ownerFree: 9, memory: memory(2) }))).toBe(2);
    const short = capacityCheck(3, capacity({ poolFree: 9, ownerFree: 9, memory: memory(2) }));
    expect(short).toMatchObject({ ok: false, free: 2 });
    expect(short.ok === false && short.message).toContain('Only 2 of 3 agents can start now: the server is low on memory');
  });

  it('says up front how many can start, and offers that number', () => {
    expect(capacityCheck(3, capacity({ poolFree: 3 }))).toEqual({ ok: true });
    expect(capacityCheck(3, null)).toEqual({ ok: true });
    const short = capacityCheck(4, capacity({ poolFree: 2 }));
    expect(short).toMatchObject({ ok: false, free: 2 });
    expect(short.ok === false && short.message).toContain('Only 2 of 4');
    const none = capacityCheck(1, capacity({ ownerFree: 0, ownerMax: 10 }));
    expect(none).toMatchObject({ ok: false, free: 0 });
    expect(none.ok === false && none.message).toContain('you can run 10 agents at once');
  });

  it('refuses a run past the free slots before paying or deploying anything', async () => {
    const { deps, calls } = makeDeps();
    await expect(runDeploys(run({ fee: 'transfer', free: 2 }), deps)).rejects.toBeInstanceOf(CapacityError);
    await expect(runDeploys(run({ fee: 'transfer', free: 2 }), deps)).rejects.toMatchObject({ free: 2 });
    expect(calls).toEqual([]);
  });
});

describe('runDeploys', () => {
  it('deploys one agent after another, each with its own name and the shared request', async () => {
    const { deps, calls, bodies } = makeDeps();
    const out = await runDeploys(run({ free: 3 }), deps);
    expect(calls).toEqual(['deploy bot 1', 'deploy bot 2', 'deploy bot 3']);
    expect(bodies.every((b) => b.model === 'gpt-x' && !('feeTxHash' in b))).toBe(true);
    expect(out.stoppedAt).toBeNull();
    expect(out.agents.map((a) => [a.state, a.id, a.started])).toEqual([
      ['done', 'agent-1', true], ['done', 'agent-2', true], ['done', 'agent-3', true],
    ]);
  });

  it('pays one transfer per agent, saved the moment it is broadcast and cleared, by its hash, once that agent exists', async () => {
    const { deps, calls, counts } = makeDeps();
    const out = await runDeploys(run({ fee: 'transfer' }), deps);
    expect(calls).toEqual([
      'pay 01', 'slot 01', 'deploy bot 1 fee 01', 'clear 01',
      'pay 02', 'slot 02', 'deploy bot 2 fee 02', 'clear 02',
      'pay 03', 'slot 03', 'deploy bot 3 fee 03', 'clear 03',
    ]);
    expect(counts().fees).toBe(3);
    expect(out.agents.map((a) => a.feeTx)).toEqual([TX(1), TX(2), TX(3)]);
  });

  it('uses a payment an earlier attempt saved for the first agent only, never paying for it again', async () => {
    const { deps, calls, counts } = makeDeps();
    const out = await runDeploys(run({ fee: 'transfer', savedFee: TX(0xee) }), deps);
    expect(calls.slice(0, 2)).toEqual(['deploy bot 1 fee ee', 'clear ee']);
    expect(calls.filter((c) => c.startsWith('pay'))).toEqual(['pay 01', 'pay 02']);
    expect(counts().fees).toBe(2);
    expect(out.agents[0].feeTx).toBe(TX(0xee));
  });

  it('ignores a saved transfer when the fee is not paid by transfer', async () => {
    const { deps, calls } = makeDeps();
    await runDeploys(run({ fee: 'none', savedFee: TX(0xee) }), deps);
    expect(calls).toEqual(['deploy bot 1', 'deploy bot 2', 'deploy bot 3']);
  });

  it('waits and sends the same request again on a 429, reusing the fee that agent paid', async () => {
    let refusals = 3;
    const agent2: unknown[] = [];
    const { deps, calls, sleeps, counts } = makeDeps({
      deploy: async (body, ok) => {
        if (body.name === 'bot 2') agent2.push(body.feeTxHash);
        if (body.name === 'bot 2' && refusals-- > 0) throw apiError('RATE_LIMIT', 429);
        return ok(body);
      },
    });
    const out = await runDeploys(run({ fee: 'transfer' }), deps);
    expect(out.stoppedAt).toBeNull();
    expect(sleeps).toEqual(RATE_LIMIT_BACKOFF_MS.slice(0, 3));
    expect(counts().fees).toBe(3);
    // All four attempts for agent 2 named the one payment it made.
    expect(agent2).toEqual([TX(2), TX(2), TX(2), TX(2)]);
    expect(calls.filter((c) => c === 'pay 02')).toHaveLength(1);
  });

  it('gives up after six rate-limited attempts and stops, the fee still saved for the next attempt', async () => {
    let tries = 0;
    const { deps, sleeps, slot, cleared, counts } = makeDeps({
      deploy: async () => { tries++; throw apiError('RATE_LIMIT', 429); },
    });
    const out = await runDeploys(run({ fee: 'transfer' }), deps);
    expect(tries).toBe(6);
    expect(sleeps).toEqual(RATE_LIMIT_BACKOFF_MS);
    expect(counts().fees).toBe(1);
    expect(slot).toEqual([TX(1)]);
    expect(cleared).toEqual([]);
    expect(out.agents.map((a) => a.state)).toEqual(['failed', 'skipped', 'skipped']);
    expect(out.agents[0].feeTx).toBe(TX(1));
  });

  it('keeps the existing retries for a fee the backend has not seen yet', async () => {
    let notFound = 2;
        const { deps, sleeps } = makeDeps({
      deploy: async (body, ok) => {
        if (notFound-- > 0) throw apiError('DEPLOY_FEE_NOT_FOUND', 404);
        return ok(body);
      },
    });
    const out = await runDeploys(run({ names: ['solo'], fee: 'transfer' }), deps);
    expect(out.agents[0].state).toBe('done');
    expect(sleeps).toEqual([5_000, 5_000]);
  });

  it('stops at the first failure: deployed agents stay listed, the rest are skipped', async () => {
        const { deps, calls } = makeDeps({
      deploy: async (body, ok) => {
        if (body.name === 'bot 2') throw apiError('AGENT_CAPACITY', 503);
        return ok(body);
      },
    });
    const out = await runDeploys(run(), deps);
    // bot 3 was never asked for.
    expect(out.stoppedAt).toBe(1);
    expect(out.agents.map((a) => a.state)).toEqual(['done', 'failed', 'skipped']);
    expect(out.agents[0]).toMatchObject({ id: 'agent-1', walletAddress: WALLET(1) });
    expect((out.agents[1].error as { code: string }).code).toBe('AGENT_CAPACITY');
    expect(calls).toEqual(['deploy bot 1']);
  });

  it('keeps a paid fee saved after a failure that did not spend it, and forgets one that can never pay', async () => {
    const kept = makeDeps({ deploy: async () => { throw apiError('INTERNAL', 500); } });
    await runDeploys(run({ fee: 'transfer' }), kept.deps);
    expect(kept.slot).toEqual([TX(1)]);
    expect(kept.cleared).toEqual([]);

    const spent = makeDeps({ deploy: async () => { throw apiError('DEPLOY_FEE_ALREADY_USED', 409); } });
    await runDeploys(run({ fee: 'transfer' }), spent.deps);
    expect(spent.slot).toEqual([TX(1)]);
    expect(spent.cleared).toEqual([TX(1)]);

    // A saved fee that can never pay is forgotten by its own hash.
    const spentSaved = makeDeps({ deploy: async () => { throw apiError('DEPLOY_FEE_ALREADY_USED', 409); } });
    await runDeploys(run({ fee: 'transfer', savedFee: TX(0xee) }), spentSaved.deps);
    expect(spentSaved.cleared).toEqual([TX(0xee)]);

    // Paid from a wallet not on the account: linking it makes the same payment count.
    const unlinked = makeDeps({ deploy: async () => { throw apiError('DEPLOY_FEE_NOT_PAID', 402, { reason: 'PAYER_NOT_LINKED' }); } });
    await runDeploys(run({ fee: 'transfer' }), unlinked.deps);
    expect(unlinked.slot).toEqual([TX(1)]);
    expect(unlinked.cleared).toEqual([]);
  });

  it('forgets a transfer that reverted after the wallet broadcast it', async () => {
    const { deps, slot, cleared, calls } = makeDeps({
      payTransfer: async (onBroadcast) => { onBroadcast(TX(9)); throw apiError('TX_REVERTED', 0); },
    });
    const out = await runDeploys(run({ fee: 'transfer' }), deps);
    expect(slot).toEqual([TX(9)]);
    expect(cleared).toEqual([TX(9)]);
    expect(calls.some((c) => c.startsWith('deploy'))).toBe(false);
    expect(out.agents.map((a) => a.state)).toEqual(['failed', 'skipped', 'skipped']);
  });

  it('stops after an agent that was created but did not start, and does not fund it', async () => {
        const { deps, calls } = makeDeps({
      deploy: async (body, ok) => ({ ...(await ok(body)), started: body.name !== 'bot 2' }),
    });
    const out = await runDeploys(run({ fundOn: ARC }), deps);
    expect(out.stoppedAt).toBe(1);
    expect(out.agents.map((a) => [a.state, a.started])).toEqual([['done', true], ['done', false], ['skipped', undefined]]);
    expect(calls.filter((c) => c.startsWith('fund'))).toEqual(['fund 01']);
  });

  it('funds each agent\'s wallet only after its deploy succeeded, never a failed one', async () => {
        const { deps, calls, counts } = makeDeps({
      deploy: async (body, ok) => {
        if (body.name === 'bot 3') throw apiError('INTERNAL', 500);
        return ok(body);
      },
    });
    const out = await runDeploys(run({ fee: 'transfer', fundOn: ARC }), deps);
    expect(calls.filter((c) => /^(deploy|fund)/.test(c))).toEqual([
      'deploy bot 1 fee 01', 'fund 01', 'deploy bot 2 fee 02', 'fund 02',
    ]);
    expect(calls.slice(-2)).toEqual(['pay 03', 'slot 03']);
    expect(counts().funds).toBe(2);
    expect(out.agents.map((a) => a.fundTx)).toEqual([TX(201), TX(202), undefined]);
  });

  it('funds the smart account where the chain\'s escrow records one, else the wallet', async () => {
        const smart = '0x' + 'ab'.repeat(20);
    const { deps, calls } = makeDeps({
      deploy: async (body, ok) => ({ ...(await ok(body)), smartAccountAddress: smart }),
    });
    await runDeploys(run({ names: ['a'], fundOn: { ...ARC, aa: false } }), deps);
    await runDeploys(run({ names: ['b'], fundOn: { ...ARC, aa: true } }), deps);
    expect(calls.filter((c) => c.startsWith('fund'))).toEqual(['fund 01', `fund ${smart.slice(-2)}`]);
  });

  it('stops when funding a wallet fails; that agent stays deployed', async () => {
    const { deps, calls } = makeDeps({ fund: async () => { throw new Error('user rejected'); } });
    const out = await runDeploys(run({ fundOn: ARC }), deps);
    expect(out.stoppedAt).toBe(0);
    expect(out.agents[0]).toMatchObject({ state: 'done', id: 'agent-1' });
    expect((out.agents[0].fundError as Error).message).toBe('user rejected');
    expect(out.agents.slice(1).map((a) => a.state)).toEqual(['skipped', 'skipped']);
    expect(calls.filter((c) => c.startsWith('deploy'))).toHaveLength(1);
  });

  it('pays through AgentFactory once per agent and waits for each credit', async () => {
    let noCredit = 2;
        const { deps, calls, sleeps, bodies } = makeDeps({
      deploy: async (body, ok) => {
        if (noCredit-- > 0) throw apiError('NO_DEPLOY_CREDIT', 402);
        return ok(body);
      },
    });
    const out = await runDeploys(run({ names: agentNames('f', 2), fee: 'factory' }), deps);
    expect(calls.filter((c) => c === 'factory')).toHaveLength(2);
    expect(bodies.every((b) => !('feeTxHash' in b))).toBe(true);
    expect(sleeps).toEqual([5_000, 5_000]);
    expect(out.agents.map((a) => a.feeTx)).toEqual([TX(101), TX(102)]);
  });

  it('reports every change of state as it happens', async () => {
    const seen: string[] = [];
    const { deps } = makeDeps({ onUpdate: (i, a) => seen.push(`${i}:${a.state}`) });
    await runDeploys(run({ names: agentNames('x', 2), fee: 'transfer', fundOn: ARC }), deps);
    expect(seen).toEqual(['0:paying', '0:deploying', '0:done', '0:funding', '0:done', '1:paying', '1:deploying', '1:done', '1:funding', '1:done']);
  });

  it('reads a rate limit from the status or the code', () => {
    expect(isRateLimited(apiError('RATE_LIMIT', 429))).toBe(true);
    expect(isRateLimited({ status: 429 })).toBe(true);
    expect(isRateLimited({ code: 'RATE_LIMIT' })).toBe(true);
    expect(isRateLimited(apiError('AGENT_CAPACITY', 503))).toBe(false);
    expect(isRateLimited(null)).toBe(false);
  });
});
