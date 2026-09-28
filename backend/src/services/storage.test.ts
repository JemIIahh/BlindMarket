import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * services/storage.ts: on a backend configured for 0G, a brief is either on
 * 0G or the upload fails loudly (nothing is paid before the upload), and
 * uploads from the one storage wallet never overlap. One upload answers
 * within 85 s (Cloudflare cuts a request off near 100 s): an attempt gets at
 * most 40 s, a stuck one gives up its turn, and the turn is held per attempt.
 */
const h = vi.hoisted(() => ({
  config: {
    ogStorageIndexerRpc: 'http://indexer.test',
    ogStoragePrivateKey: `0x${'11'.repeat(32)}`,
    ogRpcUrl: 'http://rpc.test',
    ogChainId: 16602,
  },
  upload: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('../config.js', () => ({ config: h.config }));

vi.mock('@0gfoundation/0g-storage-ts-sdk', () => {
  class Indexer {
    upload = h.upload;
    download = vi.fn();
  }
  class MemData {
    constructor(readonly bytes: Uint8Array) {}
    async merkleTree() {
      return [{ rootHash: () => `0x${'ab'.repeat(32)}` }, null];
    }
  }
  class StorageNode {
    async getStatus() {
      return null;
    }
  }
  return { Indexer, MemData, StorageNode };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    writeFileSync: h.writeFileSync,
    readFileSync: h.readFileSync,
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => true),
  };
});

const storage = await import('./storage.js');

const ROOT = `0x${'ab'.repeat(32)}`;

/** The data an SDK upload call was given. */
const textOf = (file: { bytes: Uint8Array }) => Buffer.from(file.bytes).toString();

beforeEach(() => {
  h.upload.mockReset();
  h.writeFileSync.mockReset();
  h.readFileSync.mockReset();
  h.config.ogStorageIndexerRpc = 'http://indexer.test';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('upload on a backend configured for 0G', () => {
  it('fails with 503 STORAGE_UNAVAILABLE after its retries, and keeps nothing on local disk', async () => {
    vi.useFakeTimers();
    h.upload.mockResolvedValue([null, 'storage node timeout']);
    const pending = storage.upload(Buffer.from('sealed brief'));
    const outcome = expect(pending).rejects.toMatchObject({ statusCode: 503, code: 'STORAGE_UNAVAILABLE' });
    await vi.advanceTimersByTimeAsync(5_000);
    await outcome;
    expect(h.upload).toHaveBeenCalledTimes(2);
    expect(h.writeFileSync).not.toHaveBeenCalled();
  });

  it('returns the 0G merkle root when a retry succeeds', async () => {
    vi.useFakeTimers();
    h.upload.mockResolvedValueOnce([null, 'timeout']).mockResolvedValueOnce([{ txHash: '0xfeed' }, null]);
    const pending = storage.upload(Buffer.from('sealed brief'));
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toEqual({ rootHash: ROOT, txHash: '0xfeed' });
    expect(h.writeFileSync).not.toHaveBeenCalled();
  });

  it('runs uploads one at a time, so two never share the storage wallet at once', async () => {
    const events: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    h.upload.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      events.push('start');
      await new Promise((r) => setTimeout(r, 15));
      events.push('end');
      inFlight--;
      return [{ txHash: '0x1' }, null];
    });
    await Promise.all([
      storage.upload(Buffer.from('one')),
      storage.upload(Buffer.from('two')),
      storage.upload(Buffer.from('three')),
    ]);
    expect(maxInFlight).toBe(1);
    expect(events).toEqual(['start', 'end', 'start', 'end', 'start', 'end']);
  });

  it('does not let a failed upload block the next one', async () => {
    vi.useFakeTimers();
    // By content: attempts interleave (the turn is held per attempt).
    h.upload.mockImplementation(async (file: { bytes: Uint8Array }) =>
      (textOf(file) === 'first' ? [null, 'down'] : [{ txHash: '0x2' }, null]));
    const first = storage.upload(Buffer.from('first'));
    const firstOutcome = expect(first).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    const second = storage.upload(Buffer.from('second'));
    await vi.advanceTimersByTimeAsync(5_000);
    await firstOutcome;
    await expect(second).resolves.toEqual({ rootHash: ROOT, txHash: '0x2' });
  });
});

describe('upload turns and time limits on 0G', () => {
  it('holds the turn per attempt: another upload goes during the pause before a retry', async () => {
    vi.useFakeTimers();
    const attempts: string[] = [];
    let aTries = 0;
    h.upload.mockImplementation(async (file: { bytes: Uint8Array }) => {
      attempts.push(textOf(file));
      if (textOf(file) === 'A' && ++aTries === 1) return [null, 'node busy'];
      return [{ txHash: `0x${textOf(file)}` }, null];
    });
    const a = storage.upload(Buffer.from('A'));
    const b = storage.upload(Buffer.from('B'));
    await expect(b).resolves.toMatchObject({ txHash: '0xB' });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(a).resolves.toMatchObject({ txHash: '0xA' });
    expect(attempts).toEqual(['A', 'B', 'A']);
  });

  it('gives up the turn after 40 s when the SDK never answers, so the next upload goes', async () => {
    vi.useFakeTimers();
    h.upload.mockImplementation((file: { bytes: Uint8Array }) =>
      (textOf(file) === 'stuck' ? new Promise(() => {}) : Promise.resolve([{ txHash: '0x1' }, null])));
    const stuck = storage.upload(Buffer.from('stuck'));
    const stuckOutcome = expect(stuck).rejects.toMatchObject({ statusCode: 503, code: 'STORAGE_UNAVAILABLE' });
    let nextDone = false;
    const next = storage.upload(Buffer.from('next')).then((r) => { nextDone = true; return r; });
    await vi.advanceTimersByTimeAsync(39_999);
    expect(nextDone).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(next).resolves.toEqual({ rootHash: ROOT, txHash: '0x1' });
    // The stuck one retries after the pause, gets its last 40 s, and answers 503 at 85 s.
    await vi.advanceTimersByTimeAsync(45_000);
    await stuckOutcome;
    expect(h.upload).toHaveBeenCalledTimes(3);
  });

  it('answers within 85 s however long the queue: a turn that comes too late is not taken', async () => {
    vi.useFakeTimers();
    h.upload.mockImplementation(() => new Promise(() => {}));
    const uploads = ['A', 'B', 'C'].map((name) => storage.upload(Buffer.from(name)));
    const outcomes = uploads.map((u) => expect(u).rejects.toMatchObject({ statusCode: 503, code: 'STORAGE_UNAVAILABLE' }));
    await vi.advanceTimersByTimeAsync(85_000);
    await Promise.all(outcomes);
    // A's first attempt, then B's; C's turn came with 5 s left, as did A's retry.
    expect(h.upload).toHaveBeenCalledTimes(2);
  });

  it('counts an SDK that throws as a failed attempt: it retries, and answers 503, never a 500', async () => {
    vi.useFakeTimers();
    h.upload.mockRejectedValueOnce(new Error('socket hang up')).mockResolvedValueOnce([{ txHash: '0x3' }, null]);
    const retried = storage.upload(Buffer.from('flaky'));
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(retried).resolves.toEqual({ rootHash: ROOT, txHash: '0x3' });

    h.upload.mockReset();
    h.upload.mockRejectedValue(new Error('socket hang up'));
    const failed = storage.upload(Buffer.from('down'));
    const outcome = expect(failed).rejects.toMatchObject({ statusCode: 503, code: 'STORAGE_UNAVAILABLE' });
    await vi.advanceTimersByTimeAsync(5_000);
    await outcome;
    expect(h.upload).toHaveBeenCalledTimes(2);
    expect(h.writeFileSync).not.toHaveBeenCalled();
  });
});

describe('uploadBatchLimit', () => {
  it('is 4 briefs per upload-batch on 0G, and the 50-item request limit locally', () => {
    expect(storage.UPLOAD_BATCH_LIMIT_0G).toBe(4);
    expect(storage.uploadBatchLimit()).toBe(4);
    h.config.ogStorageIndexerRpc = '';
    expect(storage.uploadBatchLimit()).toBe(50);
  });
});

describe('upload without 0G (development)', () => {
  it('stores and reads the brief locally, under its sha256', async () => {
    h.config.ogStorageIndexerRpc = '';
    const data = Buffer.from('dev brief');
    const { rootHash } = await storage.upload(data);
    expect(rootHash).toMatch(/^[0-9a-f]{64}$/);
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.writeFileSync).toHaveBeenCalledTimes(1);
    expect(String(h.writeFileSync.mock.calls[0][0])).toContain(rootHash);
    h.readFileSync.mockReturnValue(data);
    await expect(storage.download(rootHash)).resolves.toEqual(data);
  });
});
