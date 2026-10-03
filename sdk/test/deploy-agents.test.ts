import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { BlindMarket, ApiError, agentNames, freeAgentSlots, MAX_DEPLOY_AGENTS } from '../src/index.js';
import type { DeployAgentsProgress } from '../src/index.js';

/**
 * deployAgents(): several hosted agents from one template, each through
 * deployAgent(), so each passes the same checks, fee and limits as a single
 * deploy. Before anything is paid: the names, the deploy's own checks (once),
 * the room to start them all, the fee, and with gas funding, the chain and
 * the balance. Then one by one: a fee per agent and never twice, a 429 asks
 * again for the same agent, a failure stops the run, and a wallet is funded
 * only after its agent is deployed.
 */

const RECORDED_FEE = JSON.parse(readFileSync(new URL('../../fixtures/prod/deploy-fee.json', import.meta.url), 'utf-8')).data;
const SETTLEMENT = JSON.parse(readFileSync(new URL('../../fixtures/prod/health-settlement.json', import.meta.url), 'utf-8')).data;
const ARC = 5042002;
const TERMS = { ...RECORDED_FEE, chainId: ARC };
const USDC = RECORDED_FEE.token as string;
const TREASURY = RECORDED_FEE.recipient as string;
const OWNER = '0x00000000000000000000000000000000000000a1';
const wallet = (i: number) => `0x${(0xb0 + i).toString(16).padStart(40, '0')}`;
const txHash = (i: number) => `0x${i.toString(16).padStart(64, '0')}`;
const ROOM = { poolMax: 10, poolFree: 10, ownerMax: 10, ownerFree: 10, canStart: true, scope: 'process' };

const ok = (data: unknown) => ({ status: 200, json: async () => ({ success: true, data }) }) as unknown as Response;
const fail = (status: number, code: string, message = code, extra: Record<string, unknown> = {}) =>
  ({ status, json: async () => ({ success: false, error: { code, message, ...extra } }) }) as unknown as Response;
const limited = () => fail(429, 'RATE_LIMIT', 'Too many matching requests — slow down');

interface StubOptions {
  terms?: unknown;
  capacity?: unknown | 'missing';
  settlement?: unknown;
  /** Answers for POST /agents/deploy, in order; past the end each deploy succeeds as the next agent. */
  deploys?: Array<Response | 'agent'>;
}

/** Routes fetch for the deploy routes. Every request is kept, in order. */
function stub(o: StubOptions = {}) {
  let made = 0;
  const answers = [...(o.deploys ?? [])];
  const nextAgent = (body: { name: string }) => {
    made++;
    return ok({ id: `agent-${made}`, name: body.name, walletAddress: wallet(made), publicKey: '04ab', status: 'running', started: true });
  };
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (u.endsWith('/api/v1/agents/deploy/validate')) return ok({ valid: true });
    if (u.endsWith('/api/v1/agents/capacity')) return o.capacity === 'missing' ? fail(404, 'NOT_FOUND', 'Agent not found') : ok(o.capacity ?? ROOM);
    if (u.endsWith('/api/v1/agents/deploy-fee')) return ok(o.terms ?? { required: false });
    if (u.endsWith('/api/v1/api-keys/whoami')) return ok({ address: OWNER, addresses: [OWNER] });
    if (u.endsWith('/health/settlement')) return ok(o.settlement ?? SETTLEMENT);
    if (u.endsWith('/api/v1/agents/deploy')) {
      const next = answers.shift();
      return next === undefined || next === 'agent' ? nextAgent(body) : next;
    }
    throw new Error(`unhandled fetch ${u}`);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}
const posts = (fn: ReturnType<typeof stub>, path: string) => fn.mock.calls.filter((c) => String(c[0]).endsWith(path));
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));
const word = (v: bigint) => ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [v]);
const TRANSFER = new ethers.Interface(['function transfer(address,uint256)']);
const BALANCE_OF = '0x70a08231';

/** A fake signer on Arc: each send gets the next hash; `failAt` makes the nth send revert. */
function signer(o: { balance?: bigint; failAt?: number; chainId?: bigint } = {}) {
  const sent: { to: string; data: string; hash: string }[] = [];
  const signer = {
    getAddress: async () => OWNER,
    sendTransaction: vi.fn(async (tx: { to: string; data: string }) => {
      const n = sent.length + 1;
      const hash = txHash(n);
      sent.push({ ...tx, hash });
      return { hash, nonce: n, wait: async () => ({ status: o.failAt === n ? 0 : 1 }) };
    }),
    provider: {
      call: vi.fn(async (tx: { data: string }) => (tx.data.startsWith(BALANCE_OF) ? word(o.balance ?? 1_000_000_000n) : word(0n))),
      getNetwork: async () => ({ chainId: o.chainId ?? BigInt(ARC) }),
    },
  };
  return { signer: signer as unknown as ethers.Signer, sent };
}
const decode = (data: string): [string, bigint] => {
  const [to, amount] = TRANSFER.decodeFunctionData('transfer', data);
  return [String(to).toLowerCase(), amount as bigint];
};

const template = {
  name: 'scout', instructions: 'find things', provider: 'openai' as const, model: 'gpt-4o-mini', apiKey: 'sk',
  ownerPublicKey: '04' + 'ab'.repeat(64),
};
const fast = { pollIntervalMs: 0, retry: { baseDelayMs: 0 } };
const bb = () => new BlindMarket({ apiKey: 'k' });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('agentNames', () => {
  it('numbers the agents after the name, from 1', () => {
    expect(agentNames('scout', 3)).toEqual(['scout 1', 'scout 2', 'scout 3']);
  });
  it('puts the number where {n} is, every time it appears', () => {
    expect(agentNames('scout-{n}-eu ({n})', 2)).toEqual(['scout-1-eu (1)', 'scout-2-eu (2)']);
  });
  it('leaves one agent named as it is, and trims the name', () => {
    expect(agentNames('  scout ', 1)).toEqual(['scout']);
  });
  it('carries on from startAt, which numbers even one agent', () => {
    expect(agentNames('scout', 2, 4)).toEqual(['scout 4', 'scout 5']);
    expect(agentNames('scout', 1, 4)).toEqual(['scout 4']);
  });
  it('counts free slots as the smaller of the pool and the owner\'s share', () => {
    expect(freeAgentSlots({ poolFree: 2, ownerFree: 7 })).toBe(2);
    expect(freeAgentSlots({ poolFree: 9, ownerFree: 3 })).toBe(3);
    expect(freeAgentSlots({ poolFree: -1, ownerFree: 3 })).toBe(0);
  });
});

describe('BlindMarket.deployAgents — before anything is deployed', () => {
  it.each([0, MAX_DEPLOY_AGENTS + 1, 2.5])('refuses count %s with no request', async (count) => {
    const fn = stub();
    await expect(bb().deployAgents(template, { ...fast, count })).rejects.toMatchObject({ code: 'INVALID_COUNT' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('refuses a name that would run past 80 characters with a number on it', async () => {
    const fn = stub();
    await expect(bb().deployAgents({ ...template, name: 'x'.repeat(78) }, { ...fast, count: 10 })).rejects.toMatchObject({ code: 'INVALID_NAME' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('runs the deploy\'s own checks once, with the longest name', async () => {
    const fn = stub();
    await bb().deployAgents(template, { ...fast, count: 10 });
    const validations = posts(fn, '/deploy/validate');
    expect(validations).toHaveLength(1);
    expect(bodyOf(validations[0]).name).toBe('scout 10');
  });

  it('refuses when fewer can start than asked, saying how many, and deploys and pays nothing', async () => {
    const fn = stub({ terms: TERMS, capacity: { ...ROOM, poolFree: 2 } });
    const p = signer();
    const err = await bb().deployAgents(template, { ...fast, count: 3, payFee: true, payer: p.signer }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 503, code: 'AGENT_CAPACITY' });
    expect(err.body).toMatchObject({ requested: 3, free: 2 });
    expect(err.message).toContain('Only 2 of the 3');
    expect(posts(fn, '/api/v1/agents/deploy')).toHaveLength(0);
    expect(p.sent).toHaveLength(0);
  });

  it('names the owner\'s own limit when that is what binds', async () => {
    stub({ capacity: { ...ROOM, ownerMax: 10, ownerFree: 1 } });
    await expect(bb().deployAgents(template, { ...fast, count: 2 })).rejects.toThrow(/you run 9 of the 10 agents/);
  });

  it('deploys only as many as can start with upToCapacity, and refuses when none can', async () => {
    const fn = stub({ capacity: { ...ROOM, poolFree: 2 } });
    const run = await bb().deployAgents(template, { ...fast, count: 5, upToCapacity: true });
    expect(run).toMatchObject({ requested: 2, deployed: 2 });
    expect(posts(fn, '/api/v1/agents/deploy').map((c) => bodyOf(c).name)).toEqual(['scout 1', 'scout 2']);
    stub({ capacity: { ...ROOM, poolFree: 0, canStart: false } });
    await expect(bb().deployAgents(template, { ...fast, count: 5, upToCapacity: true })).rejects.toMatchObject({ code: 'AGENT_CAPACITY' });
  });

  it('goes ahead when the backend predates the capacity route', async () => {
    stub({ capacity: 'missing' });
    await expect(bb().deployAgents(template, { ...fast, count: 2 })).resolves.toMatchObject({ deployed: 2 });
  });

  it('refuses a charging backend without payFee, before any deploy', async () => {
    const fn = stub({ terms: TERMS });
    await expect(bb().deployAgents(template, { ...fast, count: 2 })).rejects.toMatchObject({ code: 'DEPLOY_FEE_REQUIRED' });
    expect(posts(fn, '/api/v1/agents/deploy')).toHaveLength(0);
  });

  it('refuses when the payer cannot cover every fee and every wallet\'s gas, with nothing sent', async () => {
    const fn = stub({ terms: TERMS });
    // 3 fees (3 USDC) + 3 × 0.05 gas = 3.15 USDC; the wallet holds 3.1.
    const p = signer({ balance: 3_100_000n });
    const err = await bb().deployAgents(template, { ...fast, count: 3, payFee: true, payer: p.signer, fund: { amountRaw: 50_000n, signer: p.signer } }).catch((e) => e);
    expect(err).toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    expect(err.body).toMatchObject({ neededRaw: '3150000', balanceRaw: '3100000' });
    expect(posts(fn, '/api/v1/agents/deploy')).toHaveLength(0);
    expect(p.sent).toHaveLength(0);
  });
});

describe('BlindMarket.deployAgents — the plan, confirmed once', () => {
  it('hands confirm what the run deploys and spends, after every check and before anything is sent', async () => {
    const fn = stub({ terms: TERMS, capacity: { ...ROOM, poolFree: 2 } });
    const p = signer();
    const EARLIER = '0x' + 'ee'.repeat(32);
    let seen: unknown;
    await bb().deployAgents({ ...template, feeTxHash: EARLIER }, {
      ...fast, count: 3, upToCapacity: true, payFee: true, payer: p.signer, fund: { amountRaw: 50_000n, signer: p.signer },
      confirm: (plan) => {
        seen = plan;
        expect(posts(fn, '/api/v1/agents/deploy')).toHaveLength(0);
        expect(p.sent).toHaveLength(0);
        return false;
      },
    }).catch((e) => expect(e).toMatchObject({ code: 'CANCELLED' }));
    expect(seen).toMatchObject({
      asked: 3, count: 2, names: ['scout 1', 'scout 2'], capacity: { poolFree: 2 },
      fee: { method: 'transfer', chain: 'arc', perAgentRaw: '1000000', paying: 1, totalRaw: '1000000', recipient: TREASURY },
      funding: { chain: 'arc', symbol: 'USDC', perAgentRaw: '50000', totalRaw: '100000' },
    });
    expect(posts(fn, '/api/v1/agents/deploy')).toHaveLength(0);
    expect(p.sent).toHaveLength(0);
  });

  it('runs once confirm says yes', async () => {
    stub();
    const run = await bb().deployAgents(template, { ...fast, count: 2, confirm: async () => true });
    expect(run.deployed).toBe(2);
  });

  it('refuses a fee above maxFeeRaw before confirming or paying', async () => {
    const fn = stub({ terms: { ...TERMS, amountRaw: '2000000' } });
    const p = signer();
    const confirm = vi.fn(() => true);
    await expect(bb().deployAgents(template, { ...fast, count: 2, payFee: true, payer: p.signer, confirm }))
      .rejects.toMatchObject({ code: 'DEPLOY_FEE_ABOVE_MAX' });
    expect(confirm).not.toHaveBeenCalled();
    expect(posts(fn, '/api/v1/agents/deploy')).toHaveLength(0);
    expect(p.sent).toHaveLength(0);
  });
});

describe('BlindMarket.deployAgents — one after another', () => {
  it('deploys each agent under its own name, in order, and lists them', async () => {
    const fn = stub();
    const events: string[] = [];
    const run = await bb().deployAgents(template, { ...fast, count: 3, onProgress: (e) => events.push(`${e.type}:${e.index}`) });
    expect(run).toMatchObject({ requested: 3, deployed: 3 });
    expect(run.stopped).toBeUndefined();
    expect(run.results.map((r) => [r.name, r.status])).toEqual([['scout 1', 'deployed'], ['scout 2', 'deployed'], ['scout 3', 'deployed']]);
    expect(posts(fn, '/api/v1/agents/deploy').map((c) => bodyOf(c).name)).toEqual(['scout 1', 'scout 2', 'scout 3']);
    expect(events).toEqual(['deploying:0', 'deployed:0', 'deploying:1', 'deployed:1', 'deploying:2', 'deployed:2']);
  });

  it('pays one fee per agent, names each in its own deploy, and reports each with its index', async () => {
    // Each agent: the credit check (402), the transfer, then the deploy naming it.
    const fn = stub({ terms: TERMS, deploys: [fail(402, 'NO_DEPLOY_CREDIT'), 'agent', fail(402, 'NO_DEPLOY_CREDIT'), 'agent', fail(402, 'NO_DEPLOY_CREDIT'), 'agent'] });
    const p = signer();
    const paid: Array<[string, number]> = [];
    const run = await bb().deployAgents(template, { ...fast, count: 3, payFee: true, payer: p.signer, onFeePaid: (h, i) => { paid.push([h, i]); } });
    expect(run.deployed).toBe(3);
    expect(p.sent).toHaveLength(3);
    for (const s of p.sent) expect(decode(s.data)).toEqual([TREASURY.toLowerCase(), 1_000_000n]);
    expect(paid).toEqual([[txHash(1), 0], [txHash(2), 1], [txHash(3), 2]]);
    const named = posts(fn, '/api/v1/agents/deploy').map(bodyOf).filter((b) => b.feeTxHash);
    expect(named.map((b) => [b.name, b.feeTxHash])).toEqual([['scout 1', txHash(1)], ['scout 2', txHash(2)], ['scout 3', txHash(3)]]);
    expect(run.results.map((r) => (r.status === 'deployed' ? r.agent.feeTxHash : null))).toEqual([txHash(1), txHash(2), txHash(3)]);
  });

  it('spends a fee from an earlier attempt on the first agent only', async () => {
    const EARLIER = '0x' + 'ee'.repeat(32);
    const fn = stub({ terms: TERMS, deploys: ['agent', fail(402, 'NO_DEPLOY_CREDIT'), 'agent'] });
    const p = signer();
    const run = await bb().deployAgents({ ...template, feeTxHash: EARLIER }, { ...fast, count: 2, payFee: true, payer: p.signer });
    expect(run.deployed).toBe(2);
    expect(p.sent).toHaveLength(1);
    const bodies = posts(fn, '/api/v1/agents/deploy').map(bodyOf);
    expect(bodies[0]).toMatchObject({ name: 'scout 1', feeTxHash: EARLIER });
    expect(bodies[1].feeTxHash).toBeUndefined();
    expect(bodies[2]).toMatchObject({ name: 'scout 2', feeTxHash: txHash(1) });
  });

  it('asks again for the same agent after a 429, naming the fee it already paid instead of paying twice', async () => {
    const fn = stub({ terms: TERMS, deploys: [fail(402, 'NO_DEPLOY_CREDIT'), limited(), limited(), 'agent'] });
    const p = signer();
    const events: DeployAgentsProgress[] = [];
    const run = await bb().deployAgents(template, { ...fast, count: 1, payFee: true, payer: p.signer, onProgress: (e) => events.push(e) });
    expect(run.deployed).toBe(1);
    expect(p.sent).toHaveLength(1);
    const bodies = posts(fn, '/api/v1/agents/deploy').map(bodyOf);
    expect(bodies.map((b) => b.feeTxHash ?? null)).toEqual([null, txHash(1), txHash(1), txHash(1)]);
    expect(events.filter((e) => e.type === 'rate-limited').map((e) => (e as { attempt: number }).attempt)).toEqual([1, 2]);
  });

  it('backs off 2, 4, 8, 16 and 32 seconds by default, then gives up on that agent', async () => {
    vi.useFakeTimers();
    try {
      stub({ deploys: Array.from({ length: 6 }, limited) });
      const waits: number[] = [];
      const done = bb().deployAgents(template, { pollIntervalMs: 0, count: 2, onProgress: (e) => { if (e.type === 'rate-limited') waits.push(e.waitMs); } });
      await vi.runAllTimersAsync();
      const run = await done;
      expect(waits).toEqual([2_000, 4_000, 8_000, 16_000, 32_000]);
      expect(run.results.map((r) => r.status)).toEqual(['failed', 'skipped']);
      expect(run.stopped).toMatchObject({ index: 0, code: 'RATE_LIMIT' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops at the first failure, keeping the agents deployed before it and skipping the rest', async () => {
    const fn = stub({ deploys: ['agent', fail(500, 'INTERNAL_ERROR', 'boom')] });
    const run = await bb().deployAgents(template, { ...fast, count: 4 });
    expect(run.results.map((r) => r.status)).toEqual(['deployed', 'failed', 'skipped', 'skipped']);
    expect(run).toMatchObject({ deployed: 1, stopped: { index: 1, code: 'INTERNAL_ERROR' } });
    expect(posts(fn, '/api/v1/agents/deploy')).toHaveLength(2);
  });

  it('stops with a capacity refusal mid-run, when another owner took the last slot', async () => {
    stub({ deploys: ['agent', fail(503, 'AGENT_CAPACITY', 'Max concurrent agents (5) reached. Your payment has not been used.')] });
    const run = await bb().deployAgents(template, { ...fast, count: 3 });
    expect(run.results.map((r) => r.status)).toEqual(['deployed', 'failed', 'skipped']);
    expect(run.stopped?.code).toBe('AGENT_CAPACITY');
  });

  it('carries the fee a failed agent paid, for the next run, and not one the backend says is spent', async () => {
    stub({ terms: TERMS, deploys: [fail(402, 'NO_DEPLOY_CREDIT'), fail(500, 'INTERNAL_ERROR', 'boom')] });
    const run = await bb().deployAgents(template, { ...fast, count: 2, payFee: true, payer: signer().signer });
    expect(run.results[0]).toMatchObject({ status: 'failed', feeTxHash: txHash(1) });

    stub({ terms: TERMS, deploys: [fail(402, 'NO_DEPLOY_CREDIT'), fail(409, 'DEPLOY_FEE_ALREADY_USED', 'used')] });
    const spent = await bb().deployAgents(template, { ...fast, count: 2, payFee: true, payer: signer().signer });
    expect(spent.results[0].status).toBe('failed');
    expect(spent.results[0]).not.toHaveProperty('feeTxHash');
  });

  it('stops after an agent that was created but did not start, and funds no wallet for it', async () => {
    stub({ deploys: [ok({ id: 'agent-x', name: 'scout 1', walletAddress: wallet(9), publicKey: '04ab', status: 'stopped', started: false })] });
    const p = signer();
    const run = await bb().deployAgents(template, { ...fast, count: 3, fund: { amountRaw: 50_000n, signer: p.signer } });
    expect(run.results.map((r) => r.status)).toEqual(['deployed', 'skipped', 'skipped']);
    expect(run.stopped).toMatchObject({ index: 0, code: 'NOT_STARTED' });
    expect(p.sent).toHaveLength(0);
  });

  it('stops before the next agent once the signal aborts', async () => {
    const controller = new AbortController();
    stub();
    const run = await bb().deployAgents(template, {
      ...fast, count: 3, signal: controller.signal,
      onProgress: (e) => { if (e.type === 'deployed' && e.index === 0) controller.abort(); },
    });
    expect(run.results.map((r) => r.status)).toEqual(['deployed', 'skipped', 'skipped']);
    expect(run.stopped).toMatchObject({ index: 1, code: 'ABORTED' });
  });
});

describe('BlindMarket.deployAgents — gas for each wallet', () => {
  it('sends each wallet its gas right after its agent is deployed, never before', async () => {
    const order: string[] = [];
    const fn = stub();
    fn.mockImplementation(((orig) => async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith('/api/v1/agents/deploy')) order.push(`deploy:${JSON.parse(String(init!.body)).name}`);
      return orig(url, init);
    })(fn.getMockImplementation()!));
    const p = signer();
    const sendTransaction = p.signer.sendTransaction as unknown as ReturnType<typeof vi.fn>;
    const inner = sendTransaction.getMockImplementation()!;
    sendTransaction.mockImplementation(async (tx: { to: string; data: string }) => {
      order.push(`fund:${decode(tx.data)[0]}`);
      return inner(tx);
    });
    const run = await bb().deployAgents(template, { ...fast, count: 2, fund: { amountRaw: 50_000n, signer: p.signer } });
    expect(order).toEqual([`deploy:scout 1`, `fund:${wallet(1)}`, `deploy:scout 2`, `fund:${wallet(2)}`]);
    for (const s of p.sent) expect(s.to).toBe(USDC);
    expect(p.sent.map((s) => decode(s.data)[1])).toEqual([50_000n, 50_000n]);
    expect(run.results.map((r) => (r.status === 'deployed' ? r.funding : null))).toEqual([
      { txHash: txHash(1), amountRaw: '50000' }, { txHash: txHash(2), amountRaw: '50000' },
    ]);
  });

  it('funds no wallet whose agent failed to deploy', async () => {
    stub({ deploys: ['agent', fail(500, 'INTERNAL_ERROR')] });
    const p = signer();
    await bb().deployAgents(template, { ...fast, count: 3, fund: { amountRaw: 50_000n, signer: p.signer } });
    expect(p.sent.map((s) => decode(s.data)[0])).toEqual([wallet(1)]);
  });

  it('stops when a wallet\'s funding fails, keeping that agent as deployed', async () => {
    stub();
    const p = signer({ failAt: 1 });
    const run = await bb().deployAgents(template, { ...fast, count: 2, fund: { amountRaw: 50_000n, signer: p.signer } });
    expect(run.results[0]).toMatchObject({ status: 'deployed', funding: { txHash: txHash(1), error: { message: expect.stringContaining('reverted') } } });
    expect(run.results[1].status).toBe('skipped');
    expect(run.stopped?.index).toBe(0);
  });

  it('refuses gas funding where gas is not the settlement token, before any deploy', async () => {
    const baseOnly = { ...SETTLEMENT, postingChain: 'base' };
    const fn = stub({ settlement: baseOnly });
    await expect(bb().deployAgents(template, { ...fast, count: 2, fund: { amountRaw: 50_000n, signer: signer().signer } }))
      .rejects.toMatchObject({ code: 'FUNDING_UNSUPPORTED' });
    expect(posts(fn, '/api/v1/agents/deploy')).toHaveLength(0);
  });

  it('refuses to fund with a token that is not the pinned deployment\'s, before any deploy', async () => {
    const swapped = {
      ...SETTLEMENT,
      chains: SETTLEMENT.chains.map((c: { chain: string; token: object }) => (c.chain === 'arc' ? { ...c, token: { ...c.token, address: '0x' + 'ad'.repeat(20) } } : c)),
    };
    const fn = stub({ settlement: swapped });
    await expect(bb().deployAgents(template, { ...fast, count: 1, fund: { amountRaw: 50_000n, signer: signer().signer } }))
      .rejects.toMatchObject({ code: 'ESCROW_NOT_PINNED' });
    expect(posts(fn, '/api/v1/agents/deploy')).toHaveLength(0);
  });

  it('refuses a funding signer on another chain', async () => {
    stub();
    await expect(bb().deployAgents(template, { ...fast, count: 1, fund: { amountRaw: 50_000n, signer: signer({ chainId: 1n }).signer } }))
      .rejects.toMatchObject({ code: 'WRONG_CHAIN' });
  });
});
