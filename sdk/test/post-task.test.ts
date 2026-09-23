import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { BlindMarket, ApiError } from '../src/index.js';
import { eciesDecrypt, aesDecrypt, hexToBytes } from '../src/crypto/index.js';

/**
 * postTask(): the whole post, from the API key owner's wallet, on the
 * backend's posting chain. Production posts on Arc: an ERC-20 escrow with no
 * relay, so the wallet signs an approve and createTask itself. The settlement
 * fixture is what production served on 2026-09-23, so these tests break when
 * that shape moves.
 */

const SETTLEMENT = JSON.parse(readFileSync(new URL('../../fixtures/prod/health-settlement.json', import.meta.url), 'utf-8')).data;
const ARC = SETTLEMENT.chains.find((c: { chain: string }) => c.chain === 'arc');
const ESCROW = ARC.escrowAddress as string;
const USDC = ARC.token.address as string;
const CHAIN_ID = ARC.chainId as number;

const OWNER = '0x00000000000000000000000000000000000000a1';
const LINKED = '0x00000000000000000000000000000000000000a2';
const FUNDED = '0x' + 'f1'.repeat(32);
const APPROVED = '0x' + 'a9'.repeat(32);
const ROOT = '0x' + '77'.repeat(32);

const executorA = ethers.Wallet.createRandom();
const executorB = ethers.Wallet.createRandom();
const EXECUTORS = [
  { address: executorA.address, publicKey: executorA.signingKey.publicKey.slice(2) },
  { address: executorB.address, publicKey: executorB.signingKey.publicKey },
];

const ok = (data: unknown) => ({ status: 200, json: async () => ({ success: true, data }) }) as unknown as Response;
const fail = (status: number, code: string, message = code) =>
  ({ status, json: async () => ({ success: false, error: { code, message } }) }) as unknown as Response;

interface Backend {
  settlement?: unknown;
  executors?: unknown[];
  built?: Record<string, unknown>;
  indexAnswers?: Response[];
  linked?: string[];
}

function stub(b: Backend = {}) {
  const uploads: string[] = [];
  const posts: Record<string, unknown>[] = [];
  const indexes: Record<string, unknown>[] = [];
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (u.endsWith('/health/settlement')) return ok(b.settlement ?? SETTLEMENT);
    if (u.endsWith('/api/v1/api-keys/whoami')) return ok({ address: OWNER, addresses: [OWNER, ...(b.linked ?? [])] });
    if (u.includes('/api/v1/a2a/executors?')) return ok({ executors: b.executors ?? EXECUTORS });
    if (u.endsWith('/api/v1/storage/upload')) { uploads.push(body.data); return ok({ rootHash: ROOT }); }
    if (u.endsWith('/api/v1/tasks')) {
      posts.push(body);
      return ok(b.built ?? { unsignedTx: { to: ESCROW, data: '0xc0ffee', from: OWNER }, chain: 'arc', chainId: CHAIN_ID });
    }
    if (u.endsWith('/api/v1/a2a/tasks/index')) {
      indexes.push(body);
      return b.indexAnswers?.shift() ?? ok({ taskHash: body.taskHash, onChainTaskId: '51', indexed: true });
    }
    if (/\/api\/v1\/tasks\/\d+\/(cancel|timeout)$/.test(u)) {
      return ok({ unsignedTx: { to: ESCROW, data: '0xca11', from: OWNER }, chain: 'arc', chainId: CHAIN_ID });
    }
    throw new Error(`unhandled fetch ${u}`);
  });
  vi.stubGlobal('fetch', fn);
  return { fn, uploads, posts, indexes };
}

const erc20 = new ethers.Interface([
  'function allowance(address,address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256)',
]);
const word = (v: bigint) => ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [v]);

function wallet(o: { address?: string; balance?: bigint; allowance?: bigint; chainId?: bigint; wait?: () => Promise<unknown> } = {}) {
  const sent: { to: string; data: string; nonce?: number; value?: bigint }[] = [];
  let nextNonce = 3;
  const signer = {
    getAddress: async () => o.address ?? OWNER,
    sendTransaction: vi.fn(async (tx: { to: string; data: string; nonce?: number; value?: bigint }) => {
      sent.push(tx);
      const nonce = tx.nonce ?? nextNonce++;
      return { hash: tx.to === USDC ? APPROVED : FUNDED, nonce, wait: o.wait ?? (async () => ({ status: 1 })) };
    }),
    provider: {
      call: vi.fn(async (tx: { data: string }) => {
        const sel = tx.data.slice(0, 10);
        if (sel === erc20.getFunction('balanceOf')!.selector) return word(o.balance ?? 10_000_000n);
        if (sel === erc20.getFunction('allowance')!.selector) return word(o.allowance ?? 0n);
        throw new Error(`unexpected read ${sel}`);
      }),
      getNetwork: async () => ({ chainId: o.chainId ?? BigInt(CHAIN_ID) }),
    },
  };
  return { signer: signer as unknown as ethers.Signer, sent };
}

const bb = () => new BlindMarket({ apiKey: 'k' });
const task = { instructions: 'Summarise the attached paper in five bullets.', amountRaw: '2000000' };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('BlindMarket.postTask — on production\'s posting chain (Arc)', () => {
  it('encrypts, wraps to each executor, approves, funds and lists the task', async () => {
    const { fn, uploads, posts, indexes } = stub();
    const w = wallet();
    const funded: string[] = [];
    const out = await bb().postTask(task, { signer: w.signer, onFunded: ({ txHash }) => { funded.push(txHash); } });

    // Executors asked for on the posting chain only.
    expect(fn.mock.calls.some((c) => String(c[0]).includes('chain=arc'))).toBe(true);

    // The brief each executor can open is the one posted.
    const index = indexes[0] as { wrappedKeys: Record<string, string> };
    const blob = Buffer.from(uploads[0], 'base64');
    for (const e of [executorA, executorB]) {
      const key = await eciesDecrypt(hexToBytes(index.wrappedKeys[e.address.toLowerCase()]), e.privateKey);
      expect(new TextDecoder().decode(await aesDecrypt(blob, key))).toBe(task.instructions);
    }

    // Approve exactly the amount to the escrow, then createTask with the next nonce and no value.
    expect(w.sent.map((t) => t.to)).toEqual([USDC, ESCROW]);
    expect(erc20.decodeFunctionData('approve', w.sent[0].data).map(String)).toEqual([ESCROW, '2000000']);
    expect(w.sent[1]).toMatchObject({ data: '0xc0ffee', nonce: 4 });
    expect(w.sent[1].value).toBeUndefined();

    expect(posts[0]).toMatchObject({ token: USDC, amount: '2000000', duration: '86400', rootHash: ROOT, verificationMode: 'auto' });
    expect(indexes[0]).toMatchObject({ txHash: FUNDED, privacy: 'private', verificationCriteria: { min_length: 10, pass_threshold: 60 } });
    expect(funded).toEqual([FUNDED]);
    expect(out).toMatchObject({ taskId: '51', txHash: FUNDED, chain: 'arc', chainId: CHAIN_ID, rootHash: ROOT, privacy: 'private', wrappedTo: 2 });
    expect(out.aesKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('posts a public task in plaintext, with no executors needed', async () => {
    const { fn, uploads, indexes } = stub({ executors: [] });
    const out = await bb().postTask({ ...task, privacy: 'public' }, { signer: wallet().signer });
    expect(Buffer.from(uploads[0], 'base64').toString()).toBe(task.instructions);
    expect(fn.mock.calls.some((c) => String(c[0]).includes('/a2a/executors'))).toBe(false);
    expect(indexes[0]).toMatchObject({ privacy: 'public', publicBrief: task.instructions });
    expect(indexes[0]).not.toHaveProperty('wrappedKeys');
    expect(out).toMatchObject({ privacy: 'public', wrappedTo: 0 });
    expect(out.aesKey).toBeUndefined();
  });

  it('skips the approve when the allowance already covers the amount', async () => {
    stub();
    const w = wallet({ allowance: 2_000_000n });
    await bb().postTask(task, { signer: w.signer });
    expect(w.sent.map((t) => t.to)).toEqual([ESCROW]);
    expect(w.sent[0].nonce).toBeUndefined();
  });

  it('wraps only to the target executor', async () => {
    const { indexes } = stub();
    await bb().postTask({ ...task, targetExecutor: executorB.address }, { signer: wallet().signer });
    expect(Object.keys((indexes[0] as { wrappedKeys: object }).wrappedKeys)).toEqual([executorB.address.toLowerCase()]);
    expect(indexes[0]).toMatchObject({ targetExecutor: executorB.address });
  });
});

describe('BlindMarket.postTask — nothing is sent until everything checks out', () => {
  const nothingHappened = (s: ReturnType<typeof stub>, w: ReturnType<typeof wallet>) => {
    expect(w.sent).toHaveLength(0);
    expect(s.uploads).toHaveLength(0);
    expect(s.posts).toHaveLength(0);
  };

  it('refuses a signer on another chain', async () => {
    const s = stub();
    const w = wallet({ chainId: 84532n });
    await expect(bb().postTask(task, { signer: w.signer })).rejects.toMatchObject({ code: 'WRONG_CHAIN' });
    nothingHappened(s, w);
  });

  it("refuses a signer that is not the API key's own wallet, even a linked one", async () => {
    const s = stub({ linked: [LINKED] });
    const w = wallet({ address: LINKED });
    await expect(bb().postTask(task, { signer: w.signer })).rejects.toMatchObject({ code: 'OWNER_MISMATCH' });
    nothingHappened(s, w);
  });

  it('refuses when the wallet cannot cover the escrow', async () => {
    const s = stub();
    const w = wallet({ balance: 1_999_999n });
    await expect(bb().postTask(task, { signer: w.signer }))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE', message: expect.stringContaining('1.999999 USDC') });
    nothingHappened(s, w);
  });

  it.each([['1.5'], ['2e6'], ['-1'], ['']])('refuses amountRaw %j', async (amountRaw) => {
    const s = stub();
    const w = wallet();
    await expect(bb().postTask({ ...task, amountRaw }, { signer: w.signer })).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    nothingHappened(s, w);
  });

  it('refuses an amount above maxAmountRaw, and a duration the escrow would revert', async () => {
    const s = stub();
    const w = wallet();
    await expect(bb().postTask(task, { signer: w.signer, maxAmountRaw: 1_000_000n })).rejects.toMatchObject({ code: 'AMOUNT_ABOVE_MAX' });
    await expect(bb().postTask({ ...task, durationSeconds: 60 }, { signer: w.signer })).rejects.toMatchObject({ code: 'INVALID_DURATION' });
    nothingHappened(s, w);
  });

  it('refuses an encrypted brief no executor could open', async () => {
    const s = stub({ executors: [] });
    const w = wallet();
    await expect(bb().postTask(task, { signer: w.signer })).rejects.toMatchObject({ code: 'NO_EXECUTORS', message: expect.stringContaining("privacy 'public'") });
    nothingHappened(s, w);
  });

  it('refuses more executors than a brief can be wrapped to', async () => {
    const many = Array.from({ length: 201 }, (_, i) => ({ address: ethers.zeroPadValue(ethers.toBeHex(i + 1), 20), publicKey: EXECUTORS[0].publicKey }));
    const s = stub({ executors: many });
    const w = wallet();
    await expect(bb().postTask(task, { signer: w.signer })).rejects.toMatchObject({ code: 'TOO_MANY_EXECUTORS' });
    nothingHappened(s, w);
  });

  it('refuses a target executor that is not registered on the posting chain', async () => {
    const s = stub();
    const w = wallet();
    await expect(bb().postTask({ ...task, targetExecutor: '0x00000000000000000000000000000000000000ee' }, { signer: w.signer }))
      .rejects.toMatchObject({ code: 'EXECUTOR_NOT_FOUND' });
    nothingHappened(s, w);
  });

  it('refuses when the backend has nowhere to post', async () => {
    const s = stub({ settlement: { ...SETTLEMENT, postingChain: null } });
    const w = wallet();
    await expect(bb().postTask(task, { signer: w.signer })).rejects.toMatchObject({ code: 'SETTLEMENT_NOT_POSTABLE' });
    nothingHappened(s, w);
  });

  it('refuses a tx built for another escrow or chain, before signing anything', async () => {
    stub({ built: { unsignedTx: { to: '0x00000000000000000000000000000000000000bb', data: '0x' }, chain: 'arc', chainId: CHAIN_ID } });
    const w = wallet();
    await expect(bb().postTask(task, { signer: w.signer })).rejects.toMatchObject({ code: 'ESCROW_MISMATCH' });
    expect(w.sent).toHaveLength(0);

    stub({ built: { unsignedTx: { to: ESCROW, data: '0x' }, chain: 'base', chainId: 84532 } });
    await expect(bb().postTask(task, { signer: w.signer })).rejects.toMatchObject({ code: 'POSTING_CHAIN_CHANGED' });
    expect(w.sent).toHaveLength(0);
  });
});

describe('BlindMarket.postTask — after the escrow is funded', () => {
  it('asks the index again while its RPC has not seen the receipt', async () => {
    const { indexes } = stub({ indexAnswers: [fail(404, 'RECEIPT_NOT_FOUND')] });
    await expect(bb().postTask(task, { signer: wallet().signer })).resolves.toMatchObject({ taskId: '51' });
    expect(indexes).toHaveLength(2);
  });

  it('hands back the funding tx and the index body when listing fails, so indexTask() finishes it', async () => {
    stub({ indexAnswers: [fail(403, 'NOT_TASK_AGENT', 'not the agent')] });
    const err = await bb().postTask(task, { signer: wallet().signer }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'NOT_TASK_AGENT', txHash: FUNDED, message: expect.stringContaining('do not post it again') });
    expect(err.body.indexParams).toMatchObject({ txHash: FUNDED, rootHash: ROOT });

    const { indexes } = stub();
    await expect(bb().indexTask(err.body.indexParams)).resolves.toMatchObject({ indexed: true });
    expect(indexes[0]).toEqual(err.body.indexParams);
  });

  it('names the funding tx when it was sent but not confirmed', async () => {
    stub();
    const timeout = Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
    const funded: string[] = [];
    const err = await bb().postTask(task, {
      signer: wallet({ allowance: 2_000_000n, wait: async () => { throw timeout; } }).signer,
      onFunded: ({ txHash }) => { funded.push(txHash); },
    }).catch((e) => e);
    expect(err).toMatchObject({ code: 'UNCONFIRMED', txHash: FUNDED });
    expect(err.body.indexParams.txHash).toBe(FUNDED);
    expect(funded).toEqual([FUNDED]);
  });
});

describe('BlindMarket refunds', () => {
  it('cancelAndRefund signs the cancel on the chain the backend names', async () => {
    stub();
    const w = wallet();
    await expect(bb().cancelAndRefund('51', { signer: w.signer })).resolves.toEqual({ txHash: FUNDED, chain: 'arc', chainId: CHAIN_ID });
    expect(w.sent[0]).toMatchObject({ to: ESCROW, data: '0xca11' });
  });

  it('reclaimAfterTimeout refuses a signer on another chain', async () => {
    stub();
    const w = wallet({ chainId: 16661n });
    await expect(bb().reclaimAfterTimeout('51', { signer: w.signer })).rejects.toMatchObject({ code: 'WRONG_CHAIN' });
    expect(w.sent).toHaveLength(0);
  });

  it('the unsigned builders still return what they did', async () => {
    stub();
    await expect(bb().cancelTask('51')).resolves.toMatchObject({ unsignedTx: { to: ESCROW }, chain: 'arc' });
  });
});
