import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { WorkerRuntime, type ExecuteTaskHandler, type TaskExecutionInfo } from '../src/executor/index.js';
import {
  aesEncrypt,
  bytesToHex,
  eciesEncrypt,
  generateAesKey,
  generateKeyPair,
} from '../src/crypto/index.js';
import { AgentCap } from '../src/types.js';
import type { A2ATaskState } from '../src/types.js';

/**
 * WorkerRuntime has zero test coverage upstream of this file — none of the
 * other SDK test files reference it (worker.test.ts covers the unrelated
 * low-level `Worker` class in src/worker/), which is exactly why the
 * acceptTask()/downloadBlob() type drift and the missing settle step went
 * unnoticed. These tests drive the private `executeTask()` directly
 * (bypassing start()'s browse/watch timers) against a stubbed `fetch` and a
 * stubbed ethers.Wallet.sendTransaction, so they run fully offline.
 */

const TASK_ID = `0x${'ab'.repeat(32)}`;
const ROOT_HASH = `0x${'cd'.repeat(32)}`;

function jsonResponse(data: unknown): Response {
  return { status: 200, json: async () => ({ success: true, data }) } as unknown as Response;
}

/** Route stubbed fetch calls by a substring match against the URL. Each
 * endpoint below has a unique path segment, so substring routing is enough. */
function stubFetch(routes: Record<string, unknown>) {
  const fn = vi.fn(async (url: string | URL) => {
    const u = String(url);
    const hit = Object.entries(routes).find(([match]) => u.includes(match));
    if (!hit) throw new Error(`worker-runtime.test.ts: unhandled fetch ${u}`);
    return jsonResponse(hit[1]);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function mkRuntime(
  wallet: { address: string; privateKey: string; publicKey: string },
  executeTask: ExecuteTaskHandler = async () => ({ done: true }),
): WorkerRuntime {
  const runtime = new WorkerRuntime({
    apiKey: 'test-key',
    displayName: 'test-agent',
    capabilities: [AgentCap.DATA_PROCESSING],
    executeTask,
  });
  // Tests call the private executeTask() directly instead of start(), which
  // normally sets `wallet` (via createAgent()/existingPrivateKey) and seeds
  // `executions` from the browse loop — so seed both by hand here.
  // biome-ignore lint/suspicious/noExplicitAny: reaching into private fields is the only way to unit-test this class without a live backend
  (runtime as any).wallet = wallet;
  // biome-ignore lint/suspicious/noExplicitAny: same as above
  (runtime as any).executions.set(TASK_ID, { taskId: TASK_ID, status: 'bidding', startedAt: Date.now() } satisfies TaskExecutionInfo);
  return runtime;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('WorkerRuntime.decodeWrappedKey', () => {
  it('decodes a wrapped-key hex string to the correct byte length — the regression this bug produced: the old code ran Object.values() on a STRING argument, which returned its first CHARACTER, so clean.length / 2 was 0 and every decrypt got an empty key', () => {
    const runtime = mkRuntime({ address: '0x1', privateKey: '0x1', publicKey: '0x1' });
    // ECIES wire format: 65-byte pubkey + 12-byte IV + 16-byte tag + 8-byte ciphertext.
    const hex = `04${'11'.repeat(64)}${'22'.repeat(12)}${'33'.repeat(16)}${'44'.repeat(8)}`;
    // biome-ignore lint/suspicious/noExplicitAny: private method under test
    const bytes: Uint8Array = (runtime as any).decodeWrappedKey(hex);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(hex.length / 2);
    expect(bytes.length).toBe(65 + 12 + 16 + 8);
  });

  it('throws on an empty wrapped key instead of silently returning an empty array', () => {
    const runtime = mkRuntime({ address: '0x1', privateKey: '0x1', publicKey: '0x1' });
    // biome-ignore lint/suspicious/noExplicitAny: private method under test
    expect(() => (runtime as any).decodeWrappedKey('')).toThrow();
  });
});

describe('WorkerRuntime.executeTask — encrypted task', () => {
  it('accepts, downloads by rootHash (not the on-chain taskHash), decrypts with the wrapped key, executes, submits, signs + broadcasts submitEvidence, and finalizes — with exec.task set from the caller-supplied A2ATaskState (the removed acceptResult.task no longer exists)', async () => {
    const worker = generateKeyPair();
    const aesKey = await generateAesKey();
    const plaintext = new TextEncoder().encode('do the thing');
    const ciphertext = await aesEncrypt(plaintext, aesKey);
    const wrappedKeyHex = bytesToHex(await eciesEncrypt(aesKey, worker.publicKey));

    let broadcastCalled = false;
    vi.spyOn(ethers.Wallet.prototype, 'sendTransaction').mockImplementation(async () => {
      broadcastCalled = true;
      return { hash: `0x${'11'.repeat(32)}`, wait: async () => ({ status: 1 }) } as unknown as ethers.TransactionResponse;
    });

    const fetchMock = stubFetch({
      '/accept': {
        taskId: TASK_ID,
        status: 'accepted',
        rootHash: ROOT_HASH,
        wrappedKey: wrappedKeyHex,
        privacy: 'private',
        assignTxHash: `0x${'22'.repeat(32)}`,
      },
      '/storage/': { rootHash: ROOT_HASH, blob: Buffer.from(ciphertext).toString('base64') },
      '/submit': {
        taskId: TASK_ID,
        onChainTaskId: '1',
        status: 'submitted',
        evidenceHash: `0x${'33'.repeat(32)}`,
        unsignedSubmitEvidence: { to: '0x000000000000000000000000000000000000ab', data: '0x1234', from: '0x000000000000000000000000000000000000cd' },
      },
      '/finalize': { taskId: TASK_ID, status: 'verified', verificationResult: { passed: true, reasons: [] } },
    });

    const a2a: A2ATaskState = { taskId: TASK_ID, status: 'assigned' };
    let seenInstructions = '';
    const runtime = mkRuntime(
      { address: '0xworker', privateKey: worker.privateKey, publicKey: worker.publicKey },
      async (ctx) => {
        seenInstructions = ctx.instructions;
        return { done: true };
      },
    );

    // biome-ignore lint/suspicious/noExplicitAny: private method under test
    await (runtime as any).executeTask(TASK_ID, a2a);

    // biome-ignore lint/suspicious/noExplicitAny: reaching into private fields to assert
    const exec = (runtime as any).executions.get(TASK_ID) as TaskExecutionInfo;
    expect(exec.task).toEqual(a2a); // not undefined — the phantom acceptResult.task assignment is gone
    expect(exec.status).toBe('completed');
    expect(seenInstructions).toBe('do the thing');
    expect(broadcastCalled).toBe(true);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/finalize'))).toBe(true);
  });
});

describe('WorkerRuntime.executeTask — public task', () => {
  it('skips ECIES/AES entirely and treats the downloaded blob as plaintext when privacy is public', async () => {
    vi.spyOn(ethers.Wallet.prototype, 'sendTransaction').mockResolvedValue(
      { hash: `0x${'11'.repeat(32)}`, wait: async () => ({ status: 1 }) } as unknown as ethers.TransactionResponse,
    );

    const plaintext = 'public brief, no crypto needed';
    stubFetch({
      // No wrappedKey at all — public tasks carry none by design.
      '/accept': { taskId: TASK_ID, status: 'accepted', rootHash: ROOT_HASH, privacy: 'public' },
      '/storage/': { rootHash: ROOT_HASH, blob: Buffer.from(plaintext, 'utf8').toString('base64') },
      '/submit': { taskId: TASK_ID, status: 'submitted', unsignedSubmitEvidence: null },
      '/finalize': { taskId: TASK_ID, status: 'submitted', awaitingPosterApproval: true },
    });

    const a2a: A2ATaskState = { taskId: TASK_ID, status: 'assigned' };
    let seenInstructions = '';
    const runtime = mkRuntime(
      { address: '0xworker', privateKey: `0x${'1'.repeat(64)}`, publicKey: `04${'1'.repeat(128)}` },
      async (ctx) => {
        seenInstructions = ctx.instructions;
        return { done: true };
      },
    );

    // biome-ignore lint/suspicious/noExplicitAny: private method under test
    await (runtime as any).executeTask(TASK_ID, a2a);

    expect(seenInstructions).toBe(plaintext);
    // biome-ignore lint/suspicious/noExplicitAny: reaching into private fields to assert
    expect(((runtime as any).executions.get(TASK_ID) as TaskExecutionInfo).status).toBe('completed');
  });
});

describe('WorkerRuntime.executeTask — settlement chain', () => {
  const wallet = { address: '0xworker', privateKey: `0x${'1'.repeat(64)}`, publicKey: `04${'1'.repeat(128)}` };
  const a2a: A2ATaskState = { taskId: TASK_ID, status: 'assigned' };

  // Stubbed, not just spied: a regression must not reach a real RPC.
  const stubSend = () => vi.spyOn(ethers.Wallet.prototype, 'sendTransaction').mockResolvedValue(
    { hash: `0x${'11'.repeat(32)}`, wait: async () => ({ status: 1 }) } as unknown as ethers.TransactionResponse,
  );

  it('fails a task on a chain it cannot sign for right after accept, before the handler runs or anything is sent', async () => {
    const sendTxSpy = stubSend();
    const handler = vi.fn(async () => ({ done: true }));
    const fetchMock = stubFetch({
      '/accept': { taskId: TASK_ID, status: 'accepted', rootHash: ROOT_HASH, privacy: 'public', chain: 'arc' },
    });
    const runtime = mkRuntime(wallet, handler);

    // biome-ignore lint/suspicious/noExplicitAny: private method under test
    await (runtime as any).executeTask(TASK_ID, a2a);

    // biome-ignore lint/suspicious/noExplicitAny: reaching into private fields to assert
    const exec = (runtime as any).executions.get(TASK_ID) as TaskExecutionInfo;
    expect(exec.status).toBe('failed');
    expect(exec.error).toMatch(/"arc", which this runtime cannot sign for/);
    expect(handler).not.toHaveBeenCalled();
    expect(sendTxSpy).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/submit'))).toBe(false);
  });

  it('refuses to sign when /submit names an unknown chain', async () => {
    const sendTxSpy = stubSend();
    stubFetch({
      '/accept': { taskId: TASK_ID, status: 'accepted', rootHash: ROOT_HASH, privacy: 'public' },
      '/storage/': { rootHash: ROOT_HASH, blob: Buffer.from('x').toString('base64') },
      '/submit': {
        taskId: TASK_ID, status: 'submitted', chain: 'solana',
        unsignedSubmitEvidence: { to: '0x00000000000000000000000000000000000000ab', data: '0x1234' },
      },
    });
    const runtime = mkRuntime(wallet);

    // biome-ignore lint/suspicious/noExplicitAny: private method under test
    await (runtime as any).executeTask(TASK_ID, a2a);

    // biome-ignore lint/suspicious/noExplicitAny: reaching into private fields to assert
    expect(((runtime as any).executions.get(TASK_ID) as TaskExecutionInfo).status).toBe('failed');
    expect(sendTxSpy).not.toHaveBeenCalled();
  });

  it('signs on the 0G RPC when the backend names no chain', async () => {
    const providers: string[] = [];
    vi.spyOn(ethers.Wallet.prototype, 'sendTransaction').mockImplementation(async function (this: ethers.Wallet) {
      providers.push((this.provider as ethers.JsonRpcProvider)._getConnection().url);
      return { hash: `0x${'11'.repeat(32)}`, wait: async () => ({ status: 1 }) } as unknown as ethers.TransactionResponse;
    });
    stubFetch({
      '/accept': { taskId: TASK_ID, status: 'accepted', rootHash: ROOT_HASH, privacy: 'public' },
      '/storage/': { rootHash: ROOT_HASH, blob: Buffer.from('x').toString('base64') },
      '/submit': {
        taskId: TASK_ID, status: 'submitted',
        unsignedSubmitEvidence: { to: '0x00000000000000000000000000000000000000ab', data: '0x1234' },
      },
      '/finalize': { taskId: TASK_ID, status: 'submitted', awaitingPosterApproval: true },
    });
    const runtime = new WorkerRuntime({
      apiKey: 'test-key', displayName: 'test-agent', capabilities: [AgentCap.DATA_PROCESSING],
      executeTask: async () => ({ done: true }),
      rpcUrls: { '0g': 'http://og.invalid', base: 'http://base.invalid' },
    });
    // biome-ignore lint/suspicious/noExplicitAny: same private seeding as mkRuntime
    (runtime as any).wallet = wallet;
    // biome-ignore lint/suspicious/noExplicitAny: same private seeding as mkRuntime
    (runtime as any).executions.set(TASK_ID, { taskId: TASK_ID, status: 'bidding', startedAt: Date.now() });

    // biome-ignore lint/suspicious/noExplicitAny: private method under test
    await (runtime as any).executeTask(TASK_ID, a2a);

    // biome-ignore lint/suspicious/noExplicitAny: reaching into private fields to assert
    expect(((runtime as any).executions.get(TASK_ID) as TaskExecutionInfo).status).toBe('completed');
    expect(providers).toEqual(['http://og.invalid']);
  });
});

describe('WorkerRuntime.executeTask — settle step', () => {
  it('does not attempt to broadcast when submitResult returns no unsignedSubmitEvidence, but still calls finalize', async () => {
    const sendTxSpy = vi.spyOn(ethers.Wallet.prototype, 'sendTransaction');

    const fetchMock = stubFetch({
      '/accept': { taskId: TASK_ID, status: 'accepted', rootHash: ROOT_HASH, privacy: 'public' },
      '/storage/': { rootHash: ROOT_HASH, blob: Buffer.from('x').toString('base64') },
      '/submit': { taskId: TASK_ID, status: 'submitted', unsignedSubmitEvidence: null },
      '/finalize': { taskId: TASK_ID, status: 'submitted', awaitingPosterApproval: true },
    });

    const a2a: A2ATaskState = { taskId: TASK_ID, status: 'assigned' };
    const runtime = mkRuntime({ address: '0xworker', privateKey: `0x${'1'.repeat(64)}`, publicKey: `04${'1'.repeat(128)}` });

    // biome-ignore lint/suspicious/noExplicitAny: private method under test
    await (runtime as any).executeTask(TASK_ID, a2a);

    expect(sendTxSpy).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/finalize'))).toBe(true);
    // biome-ignore lint/suspicious/noExplicitAny: reaching into private fields to assert
    expect(((runtime as any).executions.get(TASK_ID) as TaskExecutionInfo).status).toBe('completed');
  });
});
