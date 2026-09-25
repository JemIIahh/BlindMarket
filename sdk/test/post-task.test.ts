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

/** What the real backend builds (backend/src/services/escrow.ts). */
const ESCROW_ABI = new ethers.Interface([
  'function createTask(bytes32 taskHash, address token, uint256 amount, string category, string locationZone, uint256 duration)',
  'function cancelTask(uint256 taskId)',
  'function claimTimeout(uint256 taskId)',
]);
const createTaskData = (body: { taskHash: string; token: string; amount: string; locationZone: string; duration: string }) =>
  ESCROW_ABI.encodeFunctionData('createTask', [body.taskHash, body.token, body.amount, 'general', body.locationZone, body.duration]);

const ok = (data: unknown) => ({ status: 200, json: async () => ({ success: true, data }) }) as unknown as Response;
const fail = (status: number, code: string, message = code) =>
  ({ status, json: async () => ({ success: false, error: { code, message } }) }) as unknown as Response;

interface Backend {
  settlement?: unknown;
  executors?: unknown[];
  built?: Record<string, unknown>;
  /** The refund the backend builds, in place of the real cancelTask/claimTimeout. */
  refund?: (fn: 'cancel' | 'timeout', id: string) => Record<string, unknown>;
  indexAnswers?: Response[];
  confirmAnswers?: Response[];
  linked?: string[];
}

function stub(b: Backend = {}) {
  const uploads: string[] = [];
  const posts: Record<string, unknown>[] = [];
  const indexes: Record<string, unknown>[] = [];
  const refunds: (Record<string, unknown> | undefined)[] = [];
  const confirms: Record<string, unknown>[] = [];
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (u.endsWith('/health/settlement')) return ok(b.settlement ?? SETTLEMENT);
    if (u.endsWith('/api/v1/api-keys/whoami')) return ok({ address: OWNER, addresses: [OWNER, ...(b.linked ?? [])] });
    if (u.includes('/api/v1/a2a/executors?')) return ok({ executors: b.executors ?? EXECUTORS });
    if (u.endsWith('/api/v1/storage/upload')) { uploads.push(body.data); return ok({ rootHash: ROOT }); }
    if (u.endsWith('/api/v1/tasks')) {
      posts.push(body);
      return ok(b.built ?? { unsignedTx: { to: ESCROW, data: createTaskData(body), from: OWNER }, chain: 'arc', chainId: CHAIN_ID });
    }
    if (u.endsWith('/api/v1/a2a/tasks/index')) {
      indexes.push(body);
      return b.indexAnswers?.shift() ?? ok({ taskHash: body.taskHash, onChainTaskId: '51', indexed: true });
    }
    const refund = /\/api\/v1\/tasks\/(\d+)\/(cancel|timeout)$/.exec(u);
    if (refund) {
      refunds.push(body);
      const fn = refund[2] as 'cancel' | 'timeout';
      if (b.refund) return ok(b.refund(fn, refund[1]));
      const data = ESCROW_ABI.encodeFunctionData(fn === 'cancel' ? 'cancelTask' : 'claimTimeout', [BigInt(refund[1])]);
      return ok({ unsignedTx: { to: ESCROW, data, from: OWNER }, chain: 'arc', chainId: CHAIN_ID });
    }
    if (/\/api\/v1\/tasks\/\d+\/confirm-tx$/.test(u)) {
      confirms.push(body);
      return b.confirmAnswers?.shift() ?? ok({ confirmed: 1 });
    }
    throw new Error(`unhandled fetch ${u}`);
  });
  vi.stubGlobal('fetch', fn);
  return { fn, uploads, posts, indexes, refunds, confirms };
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
    let persisted: Record<string, unknown> | undefined;
    const out = await bb().postTask(task, { signer: w.signer, onFunded: ({ txHash, indexParams }) => { funded.push(txHash); persisted = { ...indexParams }; } });

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
    expect(w.sent[1]).toMatchObject({ data: createTaskData(posts[0] as never), nonce: 4 });
    expect(w.sent[1].value).toBeUndefined();

    expect(posts[0]).toMatchObject({ token: USDC, amount: '2000000', duration: '86400', rootHash: ROOT, verificationMode: 'auto' });
    expect(indexes[0]).toMatchObject({ txHash: FUNDED, privacy: 'private', verificationCriteria: { min_length: 10, pass_threshold: 60 } });
    expect(funded).toEqual([FUNDED]);
    expect(persisted).toEqual(indexes[0]); // enough to finish the listing after a crash
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
  it('cancelAndRefund signs the cancel on the chain the backend names, then takes the task off the market', async () => {
    const { refunds, confirms } = stub();
    const w = wallet();
    await expect(bb().cancelAndRefund('51', { signer: w.signer, chain: 'arc' }))
      .resolves.toEqual({ txHash: FUNDED, chain: 'arc', chainId: CHAIN_ID, listingClosed: true });
    expect(w.sent[0]).toEqual({ to: ESCROW, data: ESCROW_ABI.encodeFunctionData('cancelTask', [51n]) });
    expect(refunds).toEqual([{ chain: 'arc' }]);
    expect(confirms).toEqual([{ txHash: FUNDED, chain: 'arc' }]);
  });

  it('a refund stands when the backend cannot confirm it yet; it only reports the listing still open', async () => {
    stub({ confirmAnswers: [fail(409, 'NOT_CONFIRMED'), fail(409, 'NOT_CONFIRMED'), fail(409, 'NOT_CONFIRMED')] });
    const res = await bb().cancelAndRefund('51', { signer: wallet().signer });
    expect(res).toMatchObject({ txHash: FUNDED, listingClosed: false });
  }, 20_000);

  it('reclaimAfterTimeout refuses a signer on another chain', async () => {
    stub();
    const w = wallet({ chainId: 16661n });
    await expect(bb().reclaimAfterTimeout('51', { signer: w.signer })).rejects.toMatchObject({ code: 'WRONG_CHAIN' });
    expect(w.sent).toHaveLength(0);
  });

  // On an upgraded escrow, claimTimeout on delivered, never-judged work sends
  // it for review and refunds nothing (security audit run 1, C18).
  it('reclaimAfterTimeout reports an escalation, not a refund, and no closed listing', async () => {
    const claim5 = ESCROW_ABI.encodeFunctionData('claimTimeout', [5n]);
    stub({
      refund: () => ({ unsignedTx: { to: ESCROW, data: claim5 }, chain: 'arc', chainId: CHAIN_ID, outcome: 'escalate' }),
      confirmAnswers: [ok({ confirmed: true, escalated: true })],
    });
    await expect(bb().reclaimAfterTimeout('5', { signer: wallet().signer, chain: 'arc' }))
      .resolves.toEqual({ txHash: FUNDED, chain: 'arc', chainId: CHAIN_ID, listingClosed: false, outcome: 'escalate' });
  });

  it('trusts the receipt over the build: an escalation the build called a refund reports escalate', async () => {
    const claim5 = ESCROW_ABI.encodeFunctionData('claimTimeout', [5n]);
    stub({
      refund: () => ({ unsignedTx: { to: ESCROW, data: claim5 }, chain: 'arc', chainId: CHAIN_ID, outcome: 'refund' }),
      confirmAnswers: [ok({ confirmed: true, escalated: true })],
    });
    await expect(bb().reclaimAfterTimeout('5', { signer: wallet().signer, chain: 'arc' }))
      .resolves.toMatchObject({ outcome: 'escalate', listingClosed: false });
  });

  it('reports a refund the backend confirmed', async () => {
    const claim5 = ESCROW_ABI.encodeFunctionData('claimTimeout', [5n]);
    stub({ refund: () => ({ unsignedTx: { to: ESCROW, data: claim5 }, chain: 'arc', chainId: CHAIN_ID, outcome: 'refund' }) });
    await expect(bb().reclaimAfterTimeout('5', { signer: wallet().signer, chain: 'arc' }))
      .resolves.toMatchObject({ outcome: 'refund', listingClosed: true });
  });

  it('the unsigned builders still return what they did', async () => {
    stub();
    await expect(bb().cancelTask('51')).resolves.toMatchObject({ unsignedTx: { to: ESCROW }, chain: 'arc' });
  });
});

describe('BlindMarket — only the escrow call asked for is signed (security audit run 1, C41)', () => {
  const erc20Calls = new ethers.Interface(['function approve(address,uint256)', 'function transfer(address,uint256)']);
  const MAX = 2n ** 256n - 1n;
  const DEAD = '0x000000000000000000000000000000000000dEaD';

  it('refuses a "refund" that is an ERC-20 approve on the token, before signing anything', async () => {
    stub({ refund: () => ({ unsignedTx: { to: USDC, data: erc20Calls.encodeFunctionData('approve', [DEAD, MAX]) }, chain: 'arc', chainId: CHAIN_ID }) });
    const w = wallet();
    await expect(bb().cancelAndRefund('5', { signer: w.signer, chain: 'arc' })).rejects.toMatchObject({ code: 'ESCROW_MISMATCH' });
    expect(w.sent).toHaveLength(0);
  });

  it('refuses an approve, another function or another task id aimed at the escrow itself', async () => {
    for (const data of [
      erc20Calls.encodeFunctionData('approve', [DEAD, MAX]),
      ESCROW_ABI.encodeFunctionData('claimTimeout', [5n]), // the other refund
      ESCROW_ABI.encodeFunctionData('cancelTask', [6n]), // another task
      ESCROW_ABI.encodeFunctionData('cancelTask', [5n]) + 'ff', // trailing bytes
    ]) {
      stub({ refund: () => ({ unsignedTx: { to: ESCROW, data }, chain: 'arc', chainId: CHAIN_ID }) });
      const w = wallet();
      await expect(bb().cancelAndRefund('5', { signer: w.signer, chain: 'arc' }), data).rejects.toMatchObject({ code: 'TX_MISMATCH' });
      expect(w.sent).toHaveLength(0);
    }
  });

  it('refuses a refund with a value, or built for another chain than the one asked for', async () => {
    const cancel5 = ESCROW_ABI.encodeFunctionData('cancelTask', [5n]);
    stub({ refund: () => ({ unsignedTx: { to: ESCROW, data: cancel5, value: '5000000000000000000' }, chain: 'arc', chainId: CHAIN_ID }) });
    const w = wallet();
    await expect(bb().cancelAndRefund('5', { signer: w.signer, chain: 'arc' })).rejects.toMatchObject({ code: 'TX_MISMATCH' });

    const base = SETTLEMENT.chains.find((c: { chain: string }) => c.chain === 'base');
    stub({ refund: () => ({ unsignedTx: { to: base.escrowAddress, data: cancel5 }, chain: 'base', chainId: base.chainId }) });
    await expect(bb().cancelAndRefund('5', { signer: w.signer, chain: 'arc' })).rejects.toMatchObject({ code: 'CHAIN_MISMATCH' });

    // A chain id the backend's own settlement table does not give that chain.
    stub({ refund: () => ({ unsignedTx: { to: ESCROW, data: cancel5 }, chain: 'arc', chainId: 8453 }) });
    await expect(bb().cancelAndRefund('5', { signer: w.signer })).rejects.toMatchObject({ code: 'CHAIN_MISMATCH' });

    // A chain the backend lists no escrow for cannot be checked.
    stub({ refund: () => ({ unsignedTx: { to: ESCROW, data: cancel5 }, chain: 'solana', chainId: 1 }) });
    await expect(bb().cancelAndRefund('5', { signer: w.signer })).rejects.toMatchObject({ code: 'CHAIN_UNKNOWN' });
    expect(w.sent).toHaveLength(0);
  });

  it('signs only to and data of a correct refund, never the backend\'s gas, nonce, type or chainId', async () => {
    const data = ESCROW_ABI.encodeFunctionData('claimTimeout', [5n]);
    stub({ refund: () => ({ unsignedTx: { to: ESCROW, data, from: OWNER, gasLimit: '1', maxFeePerGas: '999999999999', nonce: 77, type: 0, chainId: CHAIN_ID }, chain: 'arc', chainId: CHAIN_ID }) });
    const w = wallet();
    await expect(bb().reclaimAfterTimeout('5', { signer: w.signer, chain: 'arc' })).resolves.toMatchObject({ txHash: FUNDED });
    expect(w.sent).toEqual([{ to: ESCROW, data }]);
  });

  it('postTask refuses a createTask with another amount, token, task hash or duration than it asked for', async () => {
    type Body = { taskHash: string; token: string; amount: string; locationZone: string; duration: string };
    const variants: Array<(b: Body) => Body> = [
      (b) => ({ ...b, amount: '2000000000' }),
      (b) => ({ ...b, token: '0x00000000000000000000000000000000000000cc' }),
      (b) => ({ ...b, taskHash: `0x${'99'.repeat(32)}` }),
      (b) => ({ ...b, duration: '60' }),
    ];
    for (const change of variants) {
      const s = stub();
      s.fn.mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        if (u.endsWith('/api/v1/tasks')) return ok({ unsignedTx: { to: ESCROW, data: createTaskData(change(body)) }, chain: 'arc', chainId: CHAIN_ID });
        if (u.endsWith('/health/settlement')) return ok(SETTLEMENT);
        if (u.endsWith('/api/v1/api-keys/whoami')) return ok({ address: OWNER, addresses: [OWNER] });
        if (u.endsWith('/api/v1/storage/upload')) return ok({ rootHash: ROOT });
        throw new Error(`unhandled fetch ${u}`);
      });
      const w = wallet();
      await expect(bb().postTask({ ...task, privacy: 'public' }, { signer: w.signer })).rejects.toMatchObject({ code: 'TX_MISMATCH' });
      expect(w.sent).toHaveLength(0); // not even the approve
    }
  });

  it('postTask refuses an approve dressed as the escrow funding', async () => {
    stub({ built: { unsignedTx: { to: ESCROW, data: erc20Calls.encodeFunctionData('transfer', [DEAD, 2_000_000n]) }, chain: 'arc', chainId: CHAIN_ID } });
    const w = wallet();
    await expect(bb().postTask(task, { signer: w.signer })).rejects.toMatchObject({ code: 'TX_MISMATCH' });
    expect(w.sent).toHaveLength(0);
  });
});

describe('BlindMarket.reviewResult', () => {
  it('approves or rejects a manual-verification result as the poster', async () => {
    const fn = vi.fn(async (_url: string | URL, _init?: RequestInit) => ok({ status: 'verified', verificationResult: { passed: true } }));
    vi.stubGlobal('fetch', fn);
    await expect(bb().reviewResult('0x' + 'ab'.repeat(32), { passed: false, reasons: ['missing sources'] })).resolves.toMatchObject({ status: 'verified' });
    const [url, init] = fn.mock.calls[0];
    expect(String(url)).toBe(`https://api.blindmarket.xyz/api/v1/a2a/tasks/0x${'ab'.repeat(32)}/verify`);
    expect(JSON.parse(String(init!.body))).toEqual({ passed: false, reasons: ['missing sources'] });
  });
});
