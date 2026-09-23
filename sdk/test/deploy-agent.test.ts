import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { BlindMarket, ApiError } from '../src/index.js';

/**
 * deployAgent() and the deploy fee. Production charges 1 USDC on Arc
 * (GET /api/v1/agents/deploy-fee), and the SDK used to only POST, so every
 * SDK deploy got 402 NO_DEPLOY_CREDIT. It now pays when asked to
 * ({ payFee: true }), from the API key owner's wallet only, and never spends
 * unless asked. Nothing is paid before everything checkable is checked: an
 * unspent credit, the request itself, the payer's wallet and chain, and the
 * fee against a ceiling. After paying, the hash is never lost.
 */

// What production served on 2026-09-23 (fixtures/prod), plus the chainId the
// backend adds from 31833c2.
const RECORDED = JSON.parse(readFileSync(new URL('../../fixtures/prod/deploy-fee.json', import.meta.url), 'utf-8')).data;
const ARC = 5042002;
const TRANSFER_TERMS = { ...RECORDED, chainId: ARC };

const OWNER = '0x00000000000000000000000000000000000000a1';
const LINKED = '0x00000000000000000000000000000000000000a2';
const OTHER = '0x00000000000000000000000000000000000000e1';
const USDC = RECORDED.token as string;
const TREASURY = RECORDED.recipient as string;
const FACTORY = RECORDED.factory as string;
const PAID = '0x' + 'ab'.repeat(32);
const FASTER = '0x' + 'cd'.repeat(32);
const FACTORY_TERMS = { required: true, method: 'factory', chain: 'arc', chainId: ARC, factory: FACTORY };
const AGENT = { id: 'agent-1', name: 'a', walletAddress: OTHER, publicKey: '04ab', status: 'stopped', started: true };

const ok = (data: unknown) => ({ status: 200, json: async () => ({ success: true, data }) }) as unknown as Response;
const fail = (status: number, code: string, message = code, extra: Record<string, unknown> = {}) =>
  ({ status, json: async () => ({ success: false, error: { code, message, ...extra } }) }) as unknown as Response;
const noCredit = () => fail(402, 'NO_DEPLOY_CREDIT');

interface StubOptions { owner?: string; linked?: string[]; agents?: Record<string, unknown>; feeRoute?: 'missing' }

/** Routes fetch: fee terms, whoami, agents, and a queue of answers for POST /agents/deploy. */
function stub(terms: unknown, deployAnswers: Response[], o: StubOptions = {}) {
  const owner = o.owner ?? OWNER;
  const fn = vi.fn(async (url: string | URL, _init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/api/v1/agents/deploy-fee')) return o.feeRoute === 'missing' ? fail(404, 'NOT_FOUND', 'Agent not found') : ok(terms);
    if (u.endsWith('/api/v1/api-keys/whoami')) return ok({ address: owner, addresses: [owner, ...(o.linked ?? [])] });
    if (u.endsWith('/api/v1/agents/deploy')) return deployAnswers.shift() ?? ok(AGENT);
    const agent = /\/api\/v1\/agents\/([^/]+)$/.exec(u)?.[1];
    if (agent && o.agents?.[agent]) return ok(o.agents[agent]);
    if (agent) return fail(404, 'NOT_FOUND');
    throw new Error(`unhandled fetch ${u}`);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}
const deploys = (fn: ReturnType<typeof stub>) => fn.mock.calls.filter((c) => String(c[0]).endsWith('/api/v1/agents/deploy'));
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));

const word = (v: bigint | string) => ethers.AbiCoder.defaultAbiCoder().encode([typeof v === 'string' ? 'address' : 'uint256'], [v]);

/** A fake ethers signer: records what it sends; `wait` decides how each send ends. */
function payer(address = OWNER, o: { wait?: () => Promise<unknown>; reads?: Record<string, string>; chainId?: bigint } = {}) {
  const sent: { to: string; data: string; nonce?: number }[] = [];
  let nextNonce = 7;
  const signer = {
    getAddress: async () => address,
    sendTransaction: vi.fn(async (tx: { to: string; data: string; nonce?: number }) => {
      sent.push(tx);
      const nonce = tx.nonce ?? nextNonce++;
      return { hash: PAID, nonce, wait: o.wait ?? (async () => ({ status: 1 })) };
    }),
    provider: {
      // An unmapped read answers 0: no allowance, no balance.
      call: vi.fn(async (tx: { data: string }) => o.reads?.[tx.data.slice(0, 10)] ?? word(0n)),
      getNetwork: async () => ({ chainId: o.chainId ?? BigInt(ARC) }),
    },
  };
  return { signer: signer as unknown as ethers.Signer, sent };
}

const params = {
  name: 'a', instructions: 'do things', provider: 'openai' as const, model: 'gpt-4o-mini', apiKey: 'sk',
  ownerPublicKey: '04' + 'ab'.repeat(64),
};
const fast = { pollIntervalMs: 0 };
const bb = () => new BlindMarket({ apiKey: 'k' });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('BlindMarket.deployAgent — when nothing is paid', () => {
  it('deploys at once when the backend charges nothing, without the ignored ownerAddress', async () => {
    const fn = stub({ required: false }, []);
    await expect(bb().deployAgent({ ...params, ownerAddress: OTHER }, fast)).resolves.toMatchObject({ id: 'agent-1' });
    expect(deploys(fn)).toHaveLength(1);
    expect(bodyOf(deploys(fn)[0])).not.toHaveProperty('ownerAddress');
  });

  it('deploys as 0.6 did against a backend with no fee route', async () => {
    const fn = stub(null, [], { feeRoute: 'missing' });
    await expect(bb().deployAgent(params, fast)).resolves.toMatchObject({ id: 'agent-1' });
    expect(deploys(fn)).toHaveLength(1);
  });

  it('never spends unless asked: refuses with DEPLOY_FEE_REQUIRED and the price', async () => {
    const fn = stub(TRANSFER_TERMS, [noCredit()]);
    const p = payer();
    await expect(bb().deployAgent(params, { ...fast, payer: p.signer }))
      .rejects.toMatchObject({ status: 402, code: 'DEPLOY_FEE_REQUIRED', message: expect.stringContaining('1 USDC on arc') });
    expect(p.sent).toHaveLength(0);
    expect(deploys(fn)).toHaveLength(1);
  });

  it('spends an unspent AgentFactory credit first, even when asked to pay', async () => {
    const fn = stub(TRANSFER_TERMS, [ok(AGENT)]);
    const p = payer();
    await expect(bb().deployAgent(params, { ...fast, payFee: true, payer: p.signer })).resolves.toMatchObject({ id: 'agent-1' });
    expect(p.sent).toHaveLength(0);
    expect(bodyOf(deploys(fn)[0])).not.toHaveProperty('feeTxHash');
  });

  it('pays nothing for a request the deploy refuses, and keeps its field errors', async () => {
    const fieldErrors = { fieldErrors: { name: ['String must contain at least 1 character(s)'] } };
    stub(TRANSFER_TERMS, [{ status: 400, json: async () => ({ success: false, error: fieldErrors }) } as unknown as Response]);
    const p = payer();
    const err = await bb().deployAgent({ ...params, name: '' }, { ...fast, payFee: true, payer: p.signer }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
    expect(err.body.error).toEqual(fieldErrors);
    expect(p.sent).toHaveLength(0);
  });

  it('pays nothing for an unknown skill', async () => {
    stub(TRANSFER_TERMS, [fail(404, 'SKILL_NOT_FOUND', 'No public skill "nope"')]);
    const p = payer();
    await expect(bb().deployAgent({ ...params, skillSlugs: ['nope'] }, { ...fast, payFee: true, payer: p.signer }))
      .rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' });
    expect(p.sent).toHaveLength(0);
  });

  it('pays nothing for a provider with no apiKey', async () => {
    stub(TRANSFER_TERMS, [noCredit()]);
    const p = payer();
    await expect(bb().deployAgent({ ...params, apiKey: '' }, { ...fast, payFee: true, payer: p.signer }))
      .rejects.toMatchObject({ code: 'API_KEY_REQUIRED' });
    expect(p.sent).toHaveLength(0);
  });

  it('lets a 0g-compute agent go without an apiKey', async () => {
    stub(TRANSFER_TERMS, [noCredit()]);
    const p = payer();
    await expect(bb().deployAgent({ ...params, provider: '0g-compute', apiKey: undefined }, { ...fast, payFee: true, payer: p.signer }))
      .resolves.toMatchObject({ feeTxHash: PAID });
  });

  it("refuses to pay from a wallet that is not one of the API key owner's", async () => {
    stub(TRANSFER_TERMS, [noCredit()]);
    const p = payer(OTHER);
    await expect(bb().deployAgent(params, { ...fast, payFee: true, payer: p.signer }))
      .rejects.toMatchObject({ status: 409, code: 'OWNER_MISMATCH', message: expect.stringContaining('Nothing was sent') });
    expect(p.sent).toHaveLength(0);
  });

  it('pays from a wallet linked to the API key, as the backend counts it', async () => {
    stub(TRANSFER_TERMS, [noCredit()], { linked: [LINKED] });
    const p = payer(LINKED);
    await expect(bb().deployAgent(params, { ...fast, payFee: true, payer: p.signer })).resolves.toMatchObject({ feeTxHash: PAID });
  });

  it('refuses to pay from an RPC on another chain', async () => {
    stub(TRANSFER_TERMS, [noCredit()]);
    const p = payer(OWNER, { chainId: 1n });
    await expect(bb().deployAgent(params, { ...fast, payFee: true, payer: p.signer }))
      .rejects.toMatchObject({ code: 'WRONG_CHAIN', message: expect.stringContaining(`chain ${ARC}`) });
    expect(p.sent).toHaveLength(0);
  });

  it('refuses to pay when the backend does not say which chain the fee is on', async () => {
    stub(RECORDED, [noCredit()]);
    const p = payer();
    await expect(bb().deployAgent(params, { ...fast, payFee: true, payer: p.signer }))
      .rejects.toMatchObject({ code: 'DEPLOY_FEE_CHAIN_UNKNOWN' });
    expect(p.sent).toHaveLength(0);
  });

  it('refuses a fee above the ceiling, and pays it when the ceiling is raised', async () => {
    stub({ ...TRANSFER_TERMS, amountRaw: '5000000' }, [noCredit(), noCredit()]);
    const p = payer();
    await expect(bb().deployAgent(params, { ...fast, payFee: true, payer: p.signer }))
      .rejects.toMatchObject({ code: 'DEPLOY_FEE_ABOVE_MAX', message: expect.stringContaining('5 USDC') });
    expect(p.sent).toHaveLength(0);
    await expect(bb().deployAgent(params, { ...fast, payFee: true, payer: p.signer, maxFeeRaw: 5_000_000n })).resolves.toMatchObject({ feeTxHash: PAID });
  });

  it('needs a signer, and an RPC for the fee chain, to pay', async () => {
    stub(TRANSFER_TERMS, [noCredit(), noCredit()]);
    await expect(bb().deployAgent(params, { ...fast, payFee: true })).rejects.toMatchObject({ code: 'NO_SIGNER' });
    await expect(new BlindMarket({ apiKey: 'k', executor: { privateKey: `0x${'1'.repeat(64)}`, rpcUrls: { base: 'http://x' } } }).deployAgent(params, { ...fast, payFee: true }))
      .rejects.toMatchObject({ code: 'NO_RPC', message: expect.stringContaining('rpcUrls.arc') });
  });
});

describe('BlindMarket.deployAgent — paying by transfer', () => {
  it('pays by transfer from the owner wallet, reports the hash at once, and names the payment', async () => {
    const fn = stub(TRANSFER_TERMS, [noCredit()]);
    const p = payer();
    const seen: string[] = [];
    const agent = await bb().deployAgent(params, { ...fast, payFee: true, payer: p.signer, onFeePaid: (h) => { seen.push(h); } });
    expect(agent).toMatchObject({ id: 'agent-1', feeTxHash: PAID });
    expect(seen).toEqual([PAID]);
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0].to).toBe(USDC);
    const [to, amount] = new ethers.Interface(['function transfer(address,uint256)']).decodeFunctionData('transfer', p.sent[0].data);
    expect([to, amount]).toEqual([TREASURY, 1_000_000n]);
    expect(bodyOf(deploys(fn)[1]).feeTxHash).toBe(PAID);
  });

  it.each(['DEPLOY_FEE_NOT_FOUND', 'DEPLOY_FEE_IN_USE', 'DEPLOY_FEE_CHECK_FAILED'])('asks again while the backend answers %s', async (code) => {
    const fn = stub(TRANSFER_TERMS, [noCredit(), fail(409, code), ok(AGENT)]);
    await expect(bb().deployAgent(params, { ...fast, payFee: true, payer: payer().signer })).resolves.toMatchObject({ id: 'agent-1' });
    expect(deploys(fn)).toHaveLength(3);
  });

  it('names the paid transaction when the deploy fails after paying, keeping the backend error', async () => {
    stub(TRANSFER_TERMS, [noCredit(), fail(500, 'INTERNAL_ERROR', 'boom')]);
    const err = await bb().deployAgent(params, { ...fast, payFee: true, payer: payer().signer }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 500, code: 'INTERNAL_ERROR', feeTxHash: PAID });
    expect(err.message).toContain(`params.feeTxHash = '${PAID}'`);
    expect(err.body.feeTxHash).toBe(PAID);
    expect(err.body.error.code).toBe('INTERNAL_ERROR');
  });

  it('names the payment when it was sent but not confirmed, after telling onFeePaid', async () => {
    stub(TRANSFER_TERMS, [noCredit()]);
    const seen: string[] = [];
    const timeout = Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
    const err = await bb().deployAgent(params, {
      ...fast, payFee: true, payer: payer(OWNER, { wait: async () => { throw timeout; } }).signer, onFeePaid: (h) => { seen.push(h); },
    }).catch((e) => e);
    expect(err).toMatchObject({ code: 'UNCONFIRMED', feeTxHash: PAID });
    expect(seen).toEqual([PAID]);
  });

  it('uses a payment passed in, without fetching terms or paying', async () => {
    const fn = stub(TRANSFER_TERMS, []);
    const p = payer();
    const agent = await bb().deployAgent({ ...params, feeTxHash: PAID }, { ...fast, payFee: true, payer: p.signer });
    expect(agent.feeTxHash).toBe(PAID);
    expect(p.sent).toHaveLength(0);
    expect(fn.mock.calls.some((c) => String(c[0]).endsWith('/deploy-fee'))).toBe(false);
    expect(bodyOf(deploys(fn)[0]).feeTxHash).toBe(PAID);
  });

  it('treats an empty feeTxHash as none', async () => {
    const fn = stub({ required: false }, []);
    await bb().deployAgent({ ...params, feeTxHash: '' }, fast);
    expect(bodyOf(deploys(fn)[0])).not.toHaveProperty('feeTxHash');
  });

  it('returns your agent when the payment already created it (a retry after a lost response)', async () => {
    const mine = { ...AGENT, id: 'agent-9', ownerAddress: OWNER };
    stub(TRANSFER_TERMS, [fail(409, 'DEPLOY_FEE_ALREADY_USED', 'used', { agentId: 'agent-9' })], { agents: { 'agent-9': mine } });
    await expect(bb().deployAgent({ ...params, feeTxHash: PAID }, fast))
      .resolves.toMatchObject({ id: 'agent-9', feeTxHash: PAID, alreadyDeployed: true });
  });

  it("refuses a payment that already created someone else's agent", async () => {
    const theirs = { ...AGENT, id: 'agent-8', ownerAddress: OTHER };
    stub(TRANSFER_TERMS, [fail(409, 'DEPLOY_FEE_ALREADY_USED', 'used', { agentId: 'agent-8' })], { agents: { 'agent-8': theirs } });
    await expect(bb().deployAgent({ ...params, feeTxHash: PAID }, fast)).rejects.toMatchObject({ code: 'DEPLOY_FEE_ALREADY_USED' });
  });

  it('passes the reason through, so a payment from an unlinked wallet can be told apart', async () => {
    stub(TRANSFER_TERMS, [fail(402, 'DEPLOY_FEE_NOT_PAID', 'from another wallet', { reason: 'PAYER_NOT_LINKED' })]);
    await expect(bb().deployAgent({ ...params, feeTxHash: PAID }, fast))
      .rejects.toMatchObject({ code: 'DEPLOY_FEE_NOT_PAID', reason: 'PAYER_NOT_LINKED', feeTxHash: PAID });
  });

  it('follows a sped-up payment to its replacement, and reports both hashes', async () => {
    const fn = stub(TRANSFER_TERMS, [noCredit()]);
    const seen: string[] = [];
    const replaced = Object.assign(new Error('replaced'), { code: 'TRANSACTION_REPLACED', cancelled: false, replacement: { hash: FASTER, nonce: 7 }, receipt: { status: 1 } });
    await bb().deployAgent(params, { ...fast, payFee: true, payer: payer(OWNER, { wait: async () => { throw replaced; } }).signer, onFeePaid: (h) => { seen.push(h); } });
    expect(bodyOf(deploys(fn)[1]).feeTxHash).toBe(FASTER);
    expect(seen).toEqual([PAID, FASTER]);
  });

  it('says nothing was paid when the payment reverted, and does not deploy with it', async () => {
    const fn = stub(TRANSFER_TERMS, [noCredit()]);
    const reverted = Object.assign(new Error('reverted'), { code: 'CALL_EXCEPTION' });
    await expect(bb().deployAgent(params, { ...fast, payFee: true, payer: payer(OWNER, { wait: async () => { throw reverted; } }).signer }))
      .rejects.toThrow(/reverted, so nothing was paid/);
    expect(deploys(fn)).toHaveLength(1);
  });
});

describe('BlindMarket.deployAgent — paying through AgentFactory', () => {
  const factory = new ethers.Interface(['function deployFeeUsdc() view returns (uint256)', 'function usdc() view returns (address)', 'function deployAgent(uint256)']);
  const erc20 = new ethers.Interface(['function allowance(address,address) view returns (uint256)', 'function approve(address,uint256)']);
  const reads = (allowance: bigint, fee = 1_000_000n) => ({
    [factory.getFunction('deployFeeUsdc')!.selector]: word(fee),
    [factory.getFunction('usdc')!.selector]: word(USDC),
    [erc20.getFunction('allowance')!.selector]: word(allowance),
  });

  it('approves, pays with the next nonce, then waits for the credit', async () => {
    const fn = stub(FACTORY_TERMS, [noCredit(), noCredit(), ok(AGENT)]);
    const p = payer(OWNER, { reads: reads(0n) });
    await expect(bb().deployAgent(params, { ...fast, payFee: true, payer: p.signer })).resolves.toMatchObject({ id: 'agent-1' });
    expect(p.sent.map((t) => t.to)).toEqual([USDC, FACTORY]);
    const [spender, allowance] = erc20.decodeFunctionData('approve', p.sent[0].data);
    expect([spender, allowance]).toEqual([FACTORY, 1_000_000n]);
    expect(factory.decodeFunctionData('deployAgent', p.sent[1].data)[0]).toBe(0n);
    expect(p.sent[1].nonce).toBe(8);
    expect(deploys(fn)).toHaveLength(3);
  });

  it('skips the approve when the allowance already covers the fee', async () => {
    stub(FACTORY_TERMS, [noCredit(), ok(AGENT)]);
    const p = payer(OWNER, { reads: reads(1_000_000n) });
    await bb().deployAgent(params, { ...fast, payFee: true, payer: p.signer });
    expect(p.sent.map((t) => t.to)).toEqual([FACTORY]);
  });

  it('refuses a factory fee above the ceiling', async () => {
    stub(FACTORY_TERMS, [noCredit()]);
    const p = payer(OWNER, { reads: reads(0n, 3_000_000n) });
    await expect(bb().deployAgent(params, { ...fast, payFee: true, payer: p.signer })).rejects.toMatchObject({ code: 'DEPLOY_FEE_ABOVE_MAX' });
    expect(p.sent).toHaveLength(0);
  });

  it('says the credit stays yours when the deploy fails after the factory payment', async () => {
    stub(FACTORY_TERMS, [noCredit(), fail(500, 'INTERNAL_ERROR', 'boom')]);
    const err = await bb().deployAgent(params, { ...fast, payFee: true, payer: payer(OWNER, { reads: reads(1_000_000n) }).signer }).catch((e) => e);
    expect(err.message).toMatch(/credit stays with your wallet/);
    expect(err.feeTxHash).toBeUndefined();
  });
});
