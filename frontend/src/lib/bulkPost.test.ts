import { describe, expect, it, vi } from 'vitest';
import { Interface, ZeroAddress, makeError } from 'ethers';
import { runBulkPost, type BulkDeps, type EngineRow, type RowStatus } from './bulkPost';
import { BULK_CALLS, TX_MISMATCH_MESSAGE, TxMismatchError, pinnedContracts } from './bulkCalls';
import type { BulkRow } from './bulkRows';
import { isSendable } from './bulkRunStore';
import { NotSentError, TxRevertedError } from './bulkWallet';
import { defaultSettlement } from '../config/settlement';

const BUILD = defaultSettlement().chains.arc;
const PINS = pinnedContracts('arc', { escrow: BUILD.escrow, token: BUILD.token.address });
const ATTACKER = '0x' + 'ad'.repeat(20);
const TX = (n: number) => '0x' + n.toString(16).padStart(64, '0');
const hashOf = (text: string) => '0x' + Buffer.from(text).toString('hex').padEnd(64, '0').slice(0, 64);

type Body = Record<string, unknown>;

/** The createTask an honest backend builds for a POST /tasks body (backend/src/services/escrow.ts). */
function honestOne(body: Body) {
  return {
    from: '0xposter',
    to: PINS.escrow,
    data: BULK_CALLS.encodeFunctionData('createTask', [body.taskHash, PINS.token, BigInt(body.amount as string), 'general', body.locationZone, BigInt(body.duration as string)]),
  };
}

/** The createTasks an honest backend builds for a POST /tasks/batch task list. */
function honestBatch(tasks: Body[], tamper: (terms: unknown[], i: number) => unknown[] = (t) => t) {
  return {
    from: '0xposter',
    to: PINS.escrow,
    gasLimit: 5_000_000,
    chainId: PINS.chainId,
    data: BULK_CALLS.encodeFunctionData('createTasks', [
      PINS.token,
      tasks.map((t, i) => tamper([t.taskHash, BigInt(t.amount as string), 'general', t.locationZone, BigInt(t.duration as string), ZeroAddress], i)),
    ]),
  };
}

function row(n: number, over: Partial<BulkRow> = {}): EngineRow {
  return {
    row: n, instructions: `task ${n}`, amountRaw: BigInt(n) * 1_000_000n, durationSeconds: 86_400,
    privacy: 'public', verification: 'auto', zone: 'global', capabilities: [], fingerprint: `fp${n}`, ...over,
  };
}

/** Deps that succeed, recording every call. Override what a test needs. */
function makeDeps(over: Partial<BulkDeps> = {}) {
  let txCount = 0;
  const pending = new Map<string, unknown>();
  const deps: BulkDeps = {
    poster: '0xposter',
    pins: PINS,
    prepare: vi.fn(async (instructions: string) => ({ blob: `b:${instructions}`, taskHash: hashOf(instructions), key: new Uint8Array(32) })),
    executors: vi.fn(async () => [{ address: '0x' + 'a1'.repeat(20), publicKey: 'pk' }]),
    wrap: vi.fn(async (_h: string, _k: Uint8Array, ex) => Object.fromEntries(ex.map((e: { address: string }) => [e.address, 'wrapped']))),
    seal: vi.fn(async () => ({ keyId: 'k', blob: 'sealed' })),
    upload: vi.fn(async (blob: string) => `root:${blob}`),
    uploadMany: vi.fn(async (blobs: string[]) => blobs.map((b) => `root:${b}`)),
    buildOne: vi.fn(async (body: Body) => ({ unsignedTx: honestOne(body), chain: 'arc', chainId: PINS.chainId })),
    buildBatch: vi.fn(async (tasks: Body[]) => ({ unsignedTx: honestBatch(tasks), chain: 'arc', chainId: PINS.chainId })),
    ensureAllowance: vi.fn(async () => {}),
    send: vi.fn(async (_tx, onBroadcast) => {
      const hash = TX(++txCount);
      onBroadcast(hash);
      return { hash, receipt: null };
    }),
    indexOne: vi.fn(async (body: Record<string, unknown>) => ({ resp: { onChainTaskId: `id-${body.taskHash}` }, lastErr: null })),
    indexBatch: vi.fn(async (_tx: string, _u: boolean, tasks: Record<string, unknown>[]) => ({
      resp: { results: tasks.map((t) => ({ taskHash: t.taskHash as string, onChainTaskId: `id-${t.taskHash}`, indexed: true as const })) },
      lastErr: null,
    })),
    savePending: vi.fn((e) => void pending.set(e.taskHash, e)),
    clearPending: vi.fn((h: string) => void pending.delete(h)),
    describe: (e: unknown) => (e as Error)?.message ?? String(e),
    ...over,
  };
  return { deps, pending };
}

function recorder() {
  const last = new Map<string, RowStatus>();
  return { last, onStatus: (fp: string, s: RowStatus) => void last.set(fp, s) };
}

const NO_BATCH = { supported: false, maxBatch: 0 };
const BATCH = { supported: true, maxBatch: 50 };

describe('one task per transaction (no batch create)', () => {
  it('approves the total once, then funds and lists each row', async () => {
    const { deps, pending } = makeDeps();
    const { last, onStatus } = recorder();
    const rows = [row(1), row(2), row(3)];
    expect(await runBulkPost(rows, deps, { batch: NO_BATCH, onStatus, shouldPause: () => false })).toBe('finished');
    expect(deps.ensureAllowance).toHaveBeenCalledTimes(1);
    expect(deps.ensureAllowance).toHaveBeenCalledWith(6_000_000n);
    expect(deps.send).toHaveBeenCalledTimes(3);
    expect([...last.values()].map((s) => s.state)).toEqual(['done', 'done', 'done']);
    expect(last.get('fp2')).toMatchObject({ taskHash: hashOf('task 2'), txHash: TX(2), taskId: `id-${hashOf('task 2')}` });
    expect(pending.size).toBe(0);
  });

  it('sends a public brief in the listing and the default auto rubric; manual has none', async () => {
    const { deps } = makeDeps();
    await runBulkPost([row(1), row(2, { verification: 'manual' })], deps, { batch: NO_BATCH, onStatus: () => {}, shouldPause: () => false });
    const first = vi.mocked(deps.indexOne).mock.calls[0][0];
    expect(first).toMatchObject({ privacy: 'public', publicBrief: 'task 1', verificationMode: 'auto', verificationCriteria: { min_length: 10, pass_threshold: 60 }, txHash: TX(1), isUserOp: false });
    expect(first.wrappedKeys).toBeUndefined();
    expect(vi.mocked(deps.buildOne).mock.calls[1][0]).toMatchObject({ verificationMode: 'manual', verificationCriteria: undefined, token: PINS.token, amount: '2000000', duration: '86400' });
  });

  it('wraps private briefs to the executors (fetched once) and seals them to custody', async () => {
    const { deps } = makeDeps();
    await runBulkPost([row(1, { privacy: 'private' }), row(2, { privacy: 'private' })], deps, { batch: NO_BATCH, onStatus: () => {}, shouldPause: () => false });
    expect(deps.executors).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.indexOne).mock.calls[0][0]).toMatchObject({ wrappedKeys: { ['0x' + 'a1'.repeat(20)]: 'wrapped' }, keyCustodyBlob: { keyId: 'k', blob: 'sealed' } });
    expect(vi.mocked(deps.indexOne).mock.calls[0][0].privacy).toBeUndefined();
  });

  it('fails a private row whose target is not a registered executor, before paying, and goes on', async () => {
    const { deps } = makeDeps();
    const { last, onStatus } = recorder();
    await runBulkPost([row(1, { privacy: 'private', target: '0x' + 'bb'.repeat(20) }), row(2)], deps, { batch: NO_BATCH, onStatus, shouldPause: () => false });
    expect(last.get('fp1')).toMatchObject({ state: 'failed', error: expect.stringContaining('Nothing was paid') });
    expect(last.get('fp2')?.state).toBe('done');
    expect(deps.send).toHaveBeenCalledTimes(1);
  });

  it('refuses a transaction built for another contract, unsent, and stops the run', async () => {
    const { deps } = makeDeps({ buildOne: vi.fn(async (body: Body) => ({ unsignedTx: { ...honestOne(body), to: ATTACKER } })) });
    const { last, onStatus } = recorder();
    await expect(runBulkPost([row(1), row(2)], deps, { batch: NO_BATCH, onStatus, shouldPause: () => false })).rejects.toBeInstanceOf(TxMismatchError);
    expect(deps.send).not.toHaveBeenCalled();
    expect(last.get('fp1')).toEqual({ state: 'failed', error: TX_MISMATCH_MESSAGE });
    expect(last.has('fp2')).toBe(false);
  });

  it('refuses a createTask with a tampered amount, duration or verifier, unsent', async () => {
    const tampered = [
      (b: Body) => [b.taskHash, PINS.token, 100n * BigInt(b.amount as string), 'general', b.locationZone, BigInt(b.duration as string)],
      (b: Body) => [b.taskHash, PINS.token, BigInt(b.amount as string), 'general', b.locationZone, 3_600n],
    ];
    for (const args of tampered) {
      const { deps } = makeDeps({ buildOne: vi.fn(async (body: Body) => ({ unsignedTx: { ...honestOne(body), data: BULK_CALLS.encodeFunctionData('createTask', args(body)) } })) });
      await expect(runBulkPost([row(1)], deps, { batch: NO_BATCH, onStatus: () => {}, shouldPause: () => false })).rejects.toThrow(TX_MISMATCH_MESSAGE);
      expect(deps.send).not.toHaveBeenCalled();
    }
    const { deps } = makeDeps({
      buildOne: vi.fn(async (b: Body) => ({
        unsignedTx: { ...honestOne(b), data: BULK_CALLS.encodeFunctionData('createTaskWithVerifier', [b.taskHash, PINS.token, BigInt(b.amount as string), 'general', b.locationZone, BigInt(b.duration as string), ATTACKER]) },
      })),
    });
    await expect(runBulkPost([row(1)], deps, { batch: NO_BATCH, onStatus: () => {}, shouldPause: () => false })).rejects.toBeInstanceOf(TxMismatchError);
    expect(deps.send).not.toHaveBeenCalled();
  });

  it('refuses a cancelTask handed over as the funding transaction', async () => {
    const cancel = new Interface(['function cancelTask(uint256 taskId)']).encodeFunctionData('cancelTask', [42n]);
    const { deps } = makeDeps({ buildOne: vi.fn(async (body: Body) => ({ unsignedTx: { ...honestOne(body), data: cancel } })) });
    await expect(runBulkPost([row(1)], deps, { batch: NO_BATCH, onStatus: () => {}, shouldPause: () => false })).rejects.toBeInstanceOf(TxMismatchError);
    expect(deps.send).not.toHaveBeenCalled();
  });

  it('hands the wallet only the checked target and calldata, never a gas limit or value the backend named', async () => {
    const { deps } = makeDeps({ buildOne: vi.fn(async (body: Body) => ({ unsignedTx: { ...honestOne(body), gasLimit: 16_000_000, value: '0' } })) });
    await runBulkPost([row(1)], deps, { batch: NO_BATCH, onStatus: () => {}, shouldPause: () => false });
    const [call] = vi.mocked(deps.send).mock.calls[0];
    expect(call).toEqual({ to: PINS.escrow, data: honestOne(vi.mocked(deps.buildOne).mock.calls[0][0]).data });
  });

  it("saves the row as 'sending' before the wallet has it, and its hash the moment it broadcasts", async () => {
    const { last, onStatus } = recorder();
    const seen: Array<RowStatus | undefined> = [];
    const { deps } = makeDeps({
      send: vi.fn(async (_call, onBroadcast) => {
        seen.push(last.get('fp1'));
        onBroadcast(TX(1));
        seen.push(last.get('fp1'));
        return { hash: TX(1), receipt: null };
      }),
    });
    await runBulkPost([row(1)], deps, { batch: NO_BATCH, onStatus, shouldPause: () => false });
    expect(seen).toEqual([
      { state: 'sending', taskHash: hashOf('task 1') },
      { state: 'sending', taskHash: hashOf('task 1'), txHash: TX(1) },
    ]);
    expect(last.get('fp1')?.state).toBe('done');
  });

  it("sends nothing when the 'sending' mark can't be saved, and pauses", async () => {
    const { deps } = makeDeps();
    const { last, onStatus } = recorder();
    const result = await runBulkPost([row(1), row(2)], deps, {
      batch: NO_BATCH,
      onStatus: (fp, s) => { onStatus(fp, s); return s.state !== 'sending'; },
      shouldPause: () => false,
    });
    expect(result).toBe('paused');
    expect(deps.send).not.toHaveBeenCalled();
    expect(last.get('fp1')).toMatchObject({ state: 'failed', error: expect.stringContaining("couldn't save the run's progress") });
    expect(last.has('fp2')).toBe(false);
  });

  it('pauses on a storage outage before paying, leaving the rest queued, and says "nothing was paid" once', async () => {
    const outage = Object.assign(new Error("Couldn't store the brief right now. Nothing was paid — try again in a minute."), {
      status: 503,
      code: 'STORAGE_UNAVAILABLE',
    });
    const { deps } = makeDeps({ upload: vi.fn(async () => { throw outage; }) });
    const { last, onStatus } = recorder();
    expect(await runBulkPost([row(1), row(2), row(3)], deps, { batch: NO_BATCH, onStatus, shouldPause: () => false })).toBe('paused');
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.upload).toHaveBeenCalledTimes(1);
    expect(last.get('fp1')?.state).toBe('failed');
    const error = (last.get('fp1') as { error?: string }).error ?? '';
    expect(error.match(/nothing was paid/gi)).toHaveLength(1);
    expect(last.has('fp2')).toBe(false);
    expect(last.has('fp3')).toBe(false);
  });

  it('fails only the row on a 4xx about that task (a duplicate brief), and goes on', async () => {
    const duplicate = Object.assign(new Error('A task with exactly this brief already exists.'), { status: 409 });
    let calls = 0;
    const { deps } = makeDeps({
      buildOne: vi.fn(async (body: Body) => {
        if (++calls === 1) throw duplicate;
        return { unsignedTx: honestOne(body) };
      }),
    });
    const { last, onStatus } = recorder();
    expect(await runBulkPost([row(1), row(2)], deps, { batch: NO_BATCH, onStatus, shouldPause: () => false })).toBe('finished');
    expect(last.get('fp1')).toMatchObject({ state: 'failed', error: expect.stringContaining('Nothing was paid') });
    expect(last.get('fp2')?.state).toBe('done');
    expect(deps.send).toHaveBeenCalledTimes(1);
  });

  it('pauses on an expired session or a rate limit rather than failing every row', async () => {
    for (const status of [401, 429]) {
      const failure = Object.assign(new Error(`HTTP ${status}`), { status });
      const { deps } = makeDeps({ buildOne: vi.fn(async () => { throw failure; }) });
      const { last, onStatus } = recorder();
      expect(await runBulkPost([row(1), row(2)], deps, { batch: NO_BATCH, onStatus, shouldPause: () => false })).toBe('paused');
      expect(last.has('fp2')).toBe(false);
    }
  });

  it('lists from the hash when the wallet broadcast but could not confirm, never sending again', async () => {
    const broadcastThenLost = Object.assign(makeError('network changed', 'NETWORK_ERROR'), { info: { sendTransactionHash: TX(77) } });
    const { deps } = makeDeps({ send: vi.fn(async () => { throw broadcastThenLost; }) });
    const { last, onStatus } = recorder();
    expect(await runBulkPost([row(1), row(2)], deps, { batch: NO_BATCH, onStatus, shouldPause: () => false })).toBe('finished');
    expect(vi.mocked(deps.indexOne).mock.calls[0][0].txHash).toBe(TX(77));
    expect(deps.send).toHaveBeenCalledTimes(2); // once per row, never a retry of row 1
    expect(last.get('fp1')?.state).toBe('done');
  });

  it("pauses when the wallet refuses, with nothing paid, leaving the rest queued", async () => {
    const { deps } = makeDeps({ send: vi.fn(async () => { throw makeError('user rejected action', 'ACTION_REJECTED'); }) });
    const { last, onStatus } = recorder();
    expect(await runBulkPost([row(1), row(2)], deps, { batch: NO_BATCH, onStatus, shouldPause: () => false })).toBe('paused');
    expect(last.get('fp1')).toMatchObject({ state: 'failed', error: expect.stringContaining('Nothing was paid') });
    expect(isSendable({ row: 1, ...last.get('fp1')! })).toBe(true);
    expect(last.has('fp2')).toBe(false);
  });

  it('marks nothing paid when the gas estimate failed before the wallet had it', async () => {
    const { deps, pending } = makeDeps({ send: vi.fn(async () => { throw new NotSentError(new Error('execution reverted: ERC20InsufficientAllowance')); }) });
    const { last, onStatus } = recorder();
    expect(await runBulkPost([row(1)], deps, { batch: NO_BATCH, onStatus, shouldPause: () => false })).toBe('paused');
    expect(last.get('fp1')).toMatchObject({ state: 'failed', error: expect.stringContaining('Nothing was paid') });
    expect(pending.size).toBe(0);
  });

  it('clears the pending entry of a reverted transaction (it funded nothing), leaves it re-queueable, and pauses', async () => {
    const { deps, pending } = makeDeps({
      send: vi.fn(async (_tx, onBroadcast) => {
        onBroadcast(TX(5));
        throw new TxRevertedError(TX(5));
      }),
    });
    const { last, onStatus } = recorder();
    expect(await runBulkPost([row(1), row(2)], deps, { batch: NO_BATCH, onStatus, shouldPause: () => false })).toBe('paused');
    expect(deps.savePending).toHaveBeenCalledTimes(1);
    expect(pending.size).toBe(0);
    expect(last.get('fp1')).toMatchObject({ state: 'failed', error: expect.stringContaining('reverted on-chain, so nothing was paid') });
    expect(isSendable({ row: 1, ...last.get('fp1')! })).toBe(true);
    expect(deps.indexOne).not.toHaveBeenCalled();
  });

  it('keeps a broadcast whose receipt wait failed as unconfirmed: pending kept, unlisted, paused, never re-sent', async () => {
    const { deps, pending } = makeDeps({
      send: vi.fn(async (_tx, onBroadcast) => {
        onBroadcast(TX(6));
        throw new Error('timed out waiting for the receipt');
      }),
      // Not confirmed, so the backend can't list it from the receipt yet.
      indexOne: vi.fn(async () => ({ resp: null, lastErr: new Error('receipt not found') })),
    });
    const { last, onStatus } = recorder();
    expect(await runBulkPost([row(1), row(2)], deps, { batch: NO_BATCH, onStatus, shouldPause: () => false })).toBe('paused');
    expect(last.get('fp1')).toMatchObject({ state: 'unlisted', txHash: TX(6), error: expect.stringContaining("isn't confirmed yet") });
    expect(last.get('fp1')?.error).toContain("don't post this row again");
    expect(isSendable({ row: 1, ...last.get('fp1')! })).toBe(false);
    expect(pending.get(hashOf('task 1'))).toMatchObject({ txHash: TX(6), body: expect.objectContaining({ txHash: TX(6) }) });
    expect(vi.mocked(deps.indexOne).mock.calls[0][0]).toMatchObject({ txHash: TX(6) });
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(last.has('fp2')).toBe(false);
  });

  it('lists a broadcast whose receipt wait failed once the backend sees it landed', async () => {
    const { deps, pending } = makeDeps({
      send: vi.fn(async (_tx, onBroadcast) => {
        onBroadcast(TX(8));
        throw new Error('timed out waiting for the receipt');
      }),
    });
    const { last, onStatus } = recorder();
    await runBulkPost([row(1)], deps, { batch: NO_BATCH, onStatus, shouldPause: () => false });
    expect(last.get('fp1')).toMatchObject({ state: 'done', txHash: TX(8) });
    expect(pending.size).toBe(0);
  });

  it('calls a send that returned no receipt unconfirmed when it cannot list yet', async () => {
    const { deps } = makeDeps({ indexOne: vi.fn(async () => ({ resp: null, lastErr: new Error('receipt not found') })) });
    const { last, onStatus } = recorder();
    await runBulkPost([row(1)], deps, { batch: NO_BATCH, onStatus, shouldPause: () => false });
    expect(last.get('fp1')).toMatchObject({ state: 'unlisted', txHash: TX(1), error: expect.stringContaining("isn't confirmed yet") });
  });

  it("leaves a row 'sending', maybe paid, when the wallet fails with no hash and nothing says it wasn't sent", async () => {
    // "network changed" reads as a wrong-chain error to friendlyError, but it
    // also follows a broadcast: without a hash it proves nothing.
    for (const failure of [new Error('socket hang up'), makeError('network changed', 'NETWORK_ERROR')]) {
      const { deps, pending } = makeDeps({ send: vi.fn(async () => { throw failure; }) });
      const { last, onStatus } = recorder();
      expect(await runBulkPost([row(1), row(2)], deps, { batch: NO_BATCH, onStatus, shouldPause: () => false })).toBe('paused');
      const s = last.get('fp1')!;
      expect(s).toMatchObject({ state: 'sending', taskHash: hashOf('task 1'), error: expect.stringContaining('May have been paid') });
      expect(s.txHash).toBeUndefined();
      expect(isSendable({ row: 1, ...s })).toBe(false);
      expect(pending.size).toBe(0);
      expect(deps.indexOne).not.toHaveBeenCalled();
      expect(last.has('fp2')).toBe(false);
    }
  });

  it('keeps the pending entry and pauses when listing fails after payment', async () => {
    const { deps, pending } = makeDeps({ indexOne: vi.fn(async () => ({ resp: null, lastErr: new Error('backend down') })) });
    const { last, onStatus } = recorder();
    expect(await runBulkPost([row(1), row(2)], deps, { batch: NO_BATCH, onStatus, shouldPause: () => false })).toBe('paused');
    expect(last.get('fp1')).toMatchObject({ state: 'unlisted', txHash: TX(1), error: expect.stringContaining('Retry listing') });
    expect(pending.get(hashOf('task 1'))).toMatchObject({ txHash: TX(1), body: expect.objectContaining({ txHash: TX(1) }) });
    expect(deps.send).toHaveBeenCalledTimes(1);
  });

  it('stops before the next transaction when paused', async () => {
    const { deps } = makeDeps();
    let calls = 0;
    const result = await runBulkPost([row(1), row(2), row(3)], deps, { batch: NO_BATCH, onStatus: () => {}, shouldPause: () => ++calls > 1 });
    expect(result).toBe('paused');
    expect(deps.send).toHaveBeenCalledTimes(1);
  });

  it('funds nothing when the approval fails', async () => {
    const { deps } = makeDeps({ ensureAllowance: vi.fn(async () => { throw new Error('approval refused'); }) });
    await expect(runBulkPost([row(1)], deps, { batch: NO_BATCH, onStatus: () => {}, shouldPause: () => false })).rejects.toThrow('approval refused');
    expect(deps.send).not.toHaveBeenCalled();
  });
});

describe('batch create', () => {
  it('sends one transaction per chunk and lists each through index-batch', async () => {
    const { deps, pending } = makeDeps();
    const { last, onStatus } = recorder();
    const rows = [1, 2, 3, 4, 5].map((n) => row(n));
    expect(await runBulkPost(rows, deps, { batch: BATCH, chunkSize: 2, onStatus, shouldPause: () => false })).toBe('finished');
    expect(deps.send).toHaveBeenCalledTimes(3);
    expect(deps.uploadMany).toHaveBeenCalledTimes(3);
    expect(vi.mocked(deps.buildBatch).mock.calls[0][0]).toHaveLength(2);
    expect(vi.mocked(deps.buildBatch).mock.calls[0][0][0].token).toBeUndefined();
    expect(vi.mocked(deps.indexBatch).mock.calls[2]).toEqual([TX(3), false, [expect.objectContaining({ taskHash: hashOf('task 5') })]]);
    expect([...last.values()].every((s) => s.state === 'done')).toBe(true);
    expect(pending.size).toBe(0);
  });

  it("files batch-funded tasks under the batch listing route", async () => {
    const { deps } = makeDeps({ indexBatch: vi.fn(async () => ({ resp: null, lastErr: new Error('down') })) });
    await runBulkPost([row(1), row(2)], deps, { batch: BATCH, onStatus: () => {}, shouldPause: () => false });
    expect(vi.mocked(deps.savePending).mock.calls.every(([e]) => e.route === 'batch')).toBe(true);
  });

  it('caps the chunk at the escrow MAX_BATCH', async () => {
    const { deps } = makeDeps();
    await runBulkPost([1, 2, 3].map((n) => row(n)), deps, { batch: { supported: true, maxBatch: 2 }, chunkSize: 20, onStatus: () => {}, shouldPause: () => false });
    expect(deps.send).toHaveBeenCalledTimes(2);
  });

  it('lists what it can and pauses on a per-task listing error', async () => {
    const { deps, pending } = makeDeps({
      indexBatch: vi.fn(async (_tx: string, _u: boolean, tasks: Record<string, unknown>[]) => ({
        resp: {
          results: [
            { taskHash: tasks[0].taskHash as string, onChainTaskId: '1', indexed: true as const },
            { taskHash: tasks[1].taskHash as string, error: { code: 'NOT_IN_RECEIPT', message: 'not in that transaction' } },
          ],
        },
        lastErr: null,
      })),
    });
    const { last, onStatus } = recorder();
    expect(await runBulkPost([row(1), row(2), row(3)], deps, { batch: BATCH, chunkSize: 2, onStatus, shouldPause: () => false })).toBe('paused');
    expect(last.get('fp1')?.state).toBe('done');
    expect(last.get('fp2')).toMatchObject({ state: 'unlisted', error: expect.stringContaining('not in that transaction') });
    expect(last.has('fp3')).toBe(false);
    expect([...pending.keys()]).toEqual([hashOf('task 2')]);
  });

  it('refuses a createTasks that puts the whole total into one task, unsent, and stops the run', async () => {
    // The confirmed finding: same task hashes, so a check of the answer's own
    // list passed, but one task takes everything, ends in an hour and names
    // the attacker as its verifier.
    const { deps } = makeDeps({
      buildBatch: vi.fn(async (tasks: Body[]) => ({
        unsignedTx: honestBatch(tasks, (t, i) => (i === 0 ? [t[0], 6_000_000n, t[2], t[3], 3_600n, ATTACKER] : [t[0], 1n, t[2], t[3], t[4], t[5]])),
        taskHashes: tasks.map((t) => t.taskHash as string),
      })),
    });
    const { last, onStatus } = recorder();
    await expect(runBulkPost([row(1), row(2), row(3), row(4)], deps, { batch: BATCH, chunkSize: 3, onStatus, shouldPause: () => false })).rejects.toBeInstanceOf(TxMismatchError);
    expect(deps.send).not.toHaveBeenCalled();
    for (const fp of ['fp1', 'fp2', 'fp3']) expect(last.get(fp)).toMatchObject({ state: 'failed', error: TX_MISMATCH_MESSAGE });
    expect(last.has('fp4')).toBe(false);
  });

  it('refuses a batch with a task added or dropped, unsent', async () => {
    const extra = (tasks: Body[]) => honestBatch([...tasks, { taskHash: hashOf('extra'), amount: '5000000', locationZone: 'global', duration: '86400' }]);
    const missing = (tasks: Body[]) => honestBatch(tasks.slice(1));
    for (const build of [extra, missing]) {
      const { deps } = makeDeps({ buildBatch: vi.fn(async (tasks: Body[]) => ({ unsignedTx: build(tasks) })) });
      await expect(runBulkPost([row(1), row(2)], deps, { batch: BATCH, onStatus: () => {}, shouldPause: () => false })).rejects.toBeInstanceOf(TxMismatchError);
      expect(deps.send).not.toHaveBeenCalled();
    }
  });

  it("saves every row of the chunk as 'sending' before the wallet has the transaction", async () => {
    const { last, onStatus } = recorder();
    let atSend: Array<RowStatus | undefined> = [];
    const { deps } = makeDeps({
      send: vi.fn(async (_call, onBroadcast) => {
        atSend = ['fp1', 'fp2'].map((fp) => last.get(fp));
        onBroadcast(TX(9));
        return { hash: TX(9), receipt: null };
      }),
    });
    await runBulkPost([row(1), row(2)], deps, { batch: BATCH, onStatus, shouldPause: () => false });
    expect(atSend).toEqual([
      { state: 'sending', taskHash: hashOf('task 1') },
      { state: 'sending', taskHash: hashOf('task 2') },
    ]);
    expect([...last.values()].every((s) => s.state === 'done')).toBe(true);
  });

  it('keeps a chunk broadcast whose receipt wait failed as unconfirmed: every row unlisted, pending kept', async () => {
    const { deps, pending } = makeDeps({
      send: vi.fn(async (_tx, onBroadcast) => {
        onBroadcast(TX(7));
        throw new Error('timed out waiting for the receipt');
      }),
      indexBatch: vi.fn(async () => ({ resp: null, lastErr: new Error('receipt not found') })),
    });
    const { last, onStatus } = recorder();
    expect(await runBulkPost([row(1), row(2), row(3)], deps, { batch: BATCH, chunkSize: 2, onStatus, shouldPause: () => false })).toBe('paused');
    for (const n of [1, 2]) {
      expect(last.get(`fp${n}`)).toMatchObject({ state: 'unlisted', txHash: TX(7), error: expect.stringContaining("isn't confirmed yet") });
      expect(pending.get(hashOf(`task ${n}`))).toMatchObject({ txHash: TX(7), route: 'batch' });
    }
    expect(vi.mocked(deps.indexBatch).mock.calls[0][0]).toBe(TX(7));
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(last.has('fp3')).toBe(false);
  });

  it('clears a reverted chunk (it funded nothing) and leaves its rows re-queueable', async () => {
    const { deps, pending } = makeDeps({
      send: vi.fn(async (_tx, onBroadcast) => {
        onBroadcast(TX(4));
        throw new TxRevertedError(TX(4));
      }),
    });
    const { last, onStatus } = recorder();
    expect(await runBulkPost([row(1), row(2)], deps, { batch: BATCH, onStatus, shouldPause: () => false })).toBe('paused');
    expect(pending.size).toBe(0);
    for (const fp of ['fp1', 'fp2']) {
      expect(last.get(fp)).toMatchObject({ state: 'failed', error: expect.stringContaining('nothing was paid for these tasks') });
      expect(isSendable({ row: 1, ...last.get(fp)! })).toBe(true);
    }
  });

  it("leaves every row of a chunk 'sending' when the wallet fails with no hash", async () => {
    const { deps } = makeDeps({ send: vi.fn(async () => { throw new Error('socket hang up'); }) });
    const { last, onStatus } = recorder();
    expect(await runBulkPost([row(1), row(2)], deps, { batch: BATCH, onStatus, shouldPause: () => false })).toBe('paused');
    for (const fp of ['fp1', 'fp2']) expect(last.get(fp)).toMatchObject({ state: 'sending', error: expect.stringContaining('May have been paid') });
  });

  it("sends no chunk when a row's 'sending' mark can't be saved", async () => {
    const { deps } = makeDeps();
    let marks = 0;
    const result = await runBulkPost([row(1), row(2)], deps, {
      batch: BATCH,
      // The second row's mark fails.
      onStatus: (_fp, s) => !(s.state === 'sending' && ++marks === 2),
      shouldPause: () => false,
    });
    expect(result).toBe('paused');
    expect(deps.send).not.toHaveBeenCalled();
  });
});
