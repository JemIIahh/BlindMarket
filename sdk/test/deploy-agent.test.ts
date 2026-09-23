import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { BlindMarket } from '../src/index.js';

/**
 * deployAgent() and the deploy fee. Production charges 1 USDC on Arc
 * (GET /api/v1/agents/deploy-fee), and the SDK used to only POST, so every
 * SDK deploy got 402 NO_DEPLOY_CREDIT. It now pays when asked to
 * ({ payFee: true }), from the API key owner's wallet only, and never spends
 * unless asked.
 */

const OWNER = '0x00000000000000000000000000000000000000a1';
const OTHER = '0x00000000000000000000000000000000000000e1';
const USDC = '0x3600000000000000000000000000000000000000';
const TREASURY = '0x2f8b1177c83623a560B26B38dE984e154b123D75';
const FACTORY = '0x1E9Abb2F2e66b8Af35BED730500A94760E133a3B';
const PAID = '0x' + 'ab'.repeat(32);
const FASTER = '0x' + 'cd'.repeat(32);

const TRANSFER_TERMS = { required: true, method: 'transfer', chain: 'arc', token: USDC, recipient: TREASURY, amountRaw: '1000000', decimals: 6, factory: FACTORY };
const FACTORY_TERMS = { required: true, method: 'factory', chain: 'arc', factory: FACTORY };
const AGENT = { id: 'agent-1', name: 'a', walletAddress: OTHER, publicKey: '04ab', status: 'stopped', started: true };

const ok = (data: unknown) => ({ status: 200, json: async () => ({ success: true, data }) }) as unknown as Response;
const fail = (status: number, code: string, message = code) =>
  ({ status, json: async () => ({ success: false, error: { code, message } }) }) as unknown as Response;

/** Routes fetch: fee terms, whoami, and a queue of answers for POST /agents/deploy. */
function stub(terms: unknown, deployAnswers: Response[], owner = OWNER) {
  const fn = vi.fn(async (url: string | URL, _init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/api/v1/agents/deploy-fee')) return ok(terms);
    if (u.endsWith('/api/v1/api-keys/whoami')) return ok({ address: owner, addresses: [owner] });
    if (u.endsWith('/api/v1/agents/deploy')) return deployAnswers.shift() ?? ok(AGENT);
    throw new Error(`unhandled fetch ${u}`);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}
const deploys = (fn: ReturnType<typeof stub>) => fn.mock.calls.filter((c) => String(c[0]).endsWith('/api/v1/agents/deploy'));
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));

/** A fake ethers signer: records what it sends; `wait` decides how each send ends. */
function payer(address = OWNER, wait: () => Promise<unknown> = async () => ({ status: 1 }), reads: Record<string, string> = {}) {
  const sent: { to: string; data: string }[] = [];
  const signer = {
    getAddress: async () => address,
    sendTransaction: vi.fn(async (tx: { to: string; data: string }) => { sent.push(tx); return { hash: PAID, wait }; }),
    provider: { call: vi.fn(async (tx: { data: string }) => reads[tx.data.slice(0, 10)]) },
  };
  return { signer: signer as unknown as ethers.Signer, sent, raw: signer };
}

const params = { name: 'a', instructions: 'do things', provider: 'openai' as const, model: 'gpt-4o-mini', apiKey: 'sk', ownerPublicKey: '04' + 'ab'.repeat(64) };
const fast = { pollIntervalMs: 0 };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('BlindMarket.deployAgent — the deploy fee', () => {
  it('deploys at once when the backend charges nothing, without the ignored ownerAddress', async () => {
    const fn = stub({ required: false }, []);
    const bb = new BlindMarket({ apiKey: 'k' });
    await expect(bb.deployAgent({ ...params, ownerAddress: OTHER }, fast)).resolves.toMatchObject({ id: 'agent-1' });
    expect(deploys(fn)).toHaveLength(1);
    expect(bodyOf(deploys(fn)[0])).not.toHaveProperty('ownerAddress');
  });

  it('never spends unless asked: refuses with DEPLOY_FEE_REQUIRED and the price', async () => {
    const fn = stub(TRANSFER_TERMS, [fail(402, 'NO_DEPLOY_CREDIT')]);
    const p = payer();
    const bb = new BlindMarket({ apiKey: 'k' });
    await expect(bb.deployAgent(params, { ...fast, payer: p.signer }))
      .rejects.toMatchObject({ status: 402, code: 'DEPLOY_FEE_REQUIRED', message: expect.stringContaining('1 USDC on arc') });
    expect(p.sent).toHaveLength(0);
    expect(deploys(fn)).toHaveLength(1);
  });

  it('still spends an unspent AgentFactory credit without being asked to pay', async () => {
    stub(TRANSFER_TERMS, [ok(AGENT)]);
    const bb = new BlindMarket({ apiKey: 'k' });
    await expect(bb.deployAgent(params, fast)).resolves.toMatchObject({ id: 'agent-1' });
  });

  it('pays by transfer from the owner wallet and names the payment', async () => {
    const fn = stub(TRANSFER_TERMS, []);
    const p = payer();
    const bb = new BlindMarket({ apiKey: 'k' });
    const agent = await bb.deployAgent(params, { ...fast, payFee: true, payer: p.signer });
    expect(agent).toMatchObject({ id: 'agent-1', feeTxHash: PAID });
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0].to).toBe(USDC);
    const [to, amount] = new ethers.Interface(['function transfer(address,uint256)']).decodeFunctionData('transfer', p.sent[0].data);
    expect([to, amount]).toEqual([TREASURY, 1_000_000n]);
    expect(bodyOf(deploys(fn)[0]).feeTxHash).toBe(PAID);
  });

  it('asks again while the backend has not seen the payment confirm', async () => {
    const fn = stub(TRANSFER_TERMS, [fail(409, 'DEPLOY_FEE_NOT_FOUND'), ok(AGENT)]);
    const bb = new BlindMarket({ apiKey: 'k' });
    await expect(bb.deployAgent(params, { ...fast, payFee: true, payer: payer().signer })).resolves.toMatchObject({ id: 'agent-1' });
    expect(deploys(fn)).toHaveLength(2);
  });

  it("refuses to pay from a wallet that is not the API key's owner", async () => {
    stub(TRANSFER_TERMS, [], OWNER);
    const p = payer(OTHER);
    const bb = new BlindMarket({ apiKey: 'k' });
    await expect(bb.deployAgent(params, { ...fast, payFee: true, payer: p.signer }))
      .rejects.toMatchObject({ status: 409, code: 'OWNER_MISMATCH', message: expect.stringContaining('Nothing was paid') });
    expect(p.sent).toHaveLength(0);
  });

  it('names the paid transaction when the deploy fails after paying, so a retry does not pay twice', async () => {
    stub(TRANSFER_TERMS, [fail(500, 'INTERNAL_ERROR', 'boom')]);
    const bb = new BlindMarket({ apiKey: 'k' });
    const err = await bb.deployAgent(params, { ...fast, payFee: true, payer: payer().signer }).catch((e) => e);
    expect(err.message).toContain(PAID);
    expect(err.body).toEqual({ feeTxHash: PAID });
  });

  it('uses a payment passed in, without fetching terms or paying', async () => {
    const fn = stub(TRANSFER_TERMS, []);
    const p = payer();
    const bb = new BlindMarket({ apiKey: 'k' });
    await bb.deployAgent({ ...params, feeTxHash: PAID }, { ...fast, payFee: true, payer: p.signer });
    expect(p.sent).toHaveLength(0);
    expect(fn.mock.calls.some((c) => String(c[0]).endsWith('/deploy-fee'))).toBe(false);
    expect(bodyOf(deploys(fn)[0]).feeTxHash).toBe(PAID);
  });

  it('follows a sped-up payment to its replacement', async () => {
    const fn = stub(TRANSFER_TERMS, []);
    const replaced = Object.assign(new Error('replaced'), { code: 'TRANSACTION_REPLACED', cancelled: false, replacement: { hash: FASTER }, receipt: { status: 1 } });
    const bb = new BlindMarket({ apiKey: 'k' });
    await bb.deployAgent(params, { ...fast, payFee: true, payer: payer(OWNER, async () => { throw replaced; }).signer });
    expect(bodyOf(deploys(fn)[0]).feeTxHash).toBe(FASTER);
  });

  it('says nothing was paid when the payment reverted, and does not deploy', async () => {
    const fn = stub(TRANSFER_TERMS, []);
    const reverted = Object.assign(new Error('reverted'), { code: 'CALL_EXCEPTION' });
    const bb = new BlindMarket({ apiKey: 'k' });
    await expect(bb.deployAgent(params, { ...fast, payFee: true, payer: payer(OWNER, async () => { throw reverted; }).signer }))
      .rejects.toThrow(/reverted, so nothing was paid/);
    expect(deploys(fn)).toHaveLength(0);
  });

  it('needs a signer, and an RPC for the fee chain, to pay', async () => {
    stub(TRANSFER_TERMS, []);
    await expect(new BlindMarket({ apiKey: 'k' }).deployAgent(params, { ...fast, payFee: true }))
      .rejects.toMatchObject({ code: 'NO_SIGNER' });
    await expect(new BlindMarket({ apiKey: 'k', executor: { privateKey: `0x${'1'.repeat(64)}`, rpcUrls: { base: 'http://x' } } }).deployAgent(params, { ...fast, payFee: true }))
      .rejects.toMatchObject({ code: 'NO_RPC', message: expect.stringContaining('rpcUrls.arc') });
  });

  it('pays through AgentFactory when that is the only way, then waits for the credit', async () => {
    const fn = stub(FACTORY_TERMS, [fail(402, 'NO_DEPLOY_CREDIT'), ok(AGENT)]);
    const factory = new ethers.Interface(['function deployFeeUsdc() view returns (uint256)', 'function usdc() view returns (address)', 'function deployAgent(uint256)']);
    const reads = {
      [factory.getFunction('deployFeeUsdc')!.selector]: ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [1_000_000n]),
      [factory.getFunction('usdc')!.selector]: ethers.AbiCoder.defaultAbiCoder().encode(['address'], [USDC]),
    };
    const p = payer(OWNER, async () => ({ status: 1 }), reads);
    const bb = new BlindMarket({ apiKey: 'k' });
    await expect(bb.deployAgent(params, { ...fast, payFee: true, payer: p.signer })).resolves.toMatchObject({ id: 'agent-1' });
    expect(p.sent.map((t) => t.to)).toEqual([USDC, FACTORY]);
    const [spender, allowance] = new ethers.Interface(['function approve(address,uint256)']).decodeFunctionData('approve', p.sent[0].data);
    expect([spender, allowance]).toEqual([FACTORY, 1_000_000n]);
    expect(factory.decodeFunctionData('deployAgent', p.sent[1].data)[0]).toBe(0n);
    expect(deploys(fn)).toHaveLength(2);
  });
});
