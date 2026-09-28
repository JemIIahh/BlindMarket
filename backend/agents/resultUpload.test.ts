import { describe, it, expect, vi } from 'vitest';

/**
 * The worker stores a finished result before it submits. A storage outage
 * (503 STORAGE_UNAVAILABLE) or a network error used to release the task and
 * throw the finished work away; the upload is now tried again, twice, after
 * 20 s and then 40 s, never when the retry would run into the task's
 * deadline, and never for a request the backend refused (4xx) or a 500.
 */

vi.mock('ai', () => ({ tool: (d: unknown) => d, generateText: vi.fn(), generateObject: vi.fn(), stepCountIs: (n: number) => n }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: () => () => 'm' }));
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: () => () => 'm' }));
vi.mock('@ai-sdk/groq', () => ({ createGroq: () => () => 'm' }));
vi.mock('socket.io-client', () => ({ io: () => ({ on: vi.fn(), emit: vi.fn() }) }));

import {
  uploadResultWithRetry,
  isRetryableUploadFailure,
  RESULT_UPLOAD_BACKOFF_MS,
  // @ts-expect-error — plain-JS worker, no d.ts
} from './worker.js';

const ROOT = 'ab'.repeat(32);
const NOW = 1_800_000_000_000;

/** A fetch Response as the upload sees it. */
function answer(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}
const stored = () => answer(201, { success: true, data: { rootHash: ROOT } });
const unavailable = () => answer(503, { success: false, error: { code: 'STORAGE_UNAVAILABLE', message: "Couldn't store the brief right now." } });

function run(responses: Array<() => unknown>, opts: { deadlineMs?: number | null } = {}) {
  const upload = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    return next();
  });
  const sleeps: number[] = [];
  const logs: string[] = [];
  const result = uploadResultWithRetry(upload, {
    deadlineMs: opts.deadlineMs ?? null,
    now: () => NOW + sleeps.reduce((a, b) => a + b, 0),
    sleep: async (ms: number) => { sleeps.push(ms); },
    log: (m: string) => logs.push(m),
  });
  return { upload, sleeps, logs, result };
}

describe('uploadResultWithRetry', () => {
  it('returns the rootHash of a result stored at once', async () => {
    const { result, upload, sleeps } = run([stored]);
    expect(await result).toBe(ROOT);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('tries again after 20 s when storage is unavailable, and keeps the work', async () => {
    const { result, upload, sleeps, logs } = run([unavailable, stored]);
    expect(await result).toBe(ROOT);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([20_000]);
    expect(logs[0]).toBe('0G Storage upload failed: 503 STORAGE_UNAVAILABLE — trying again in 20s (attempt 2 of 3)');
  });

  it('gives up after 3 attempts, 20 s then 40 s apart', async () => {
    const { result, upload, sleeps, logs } = run([unavailable, unavailable, unavailable]);
    expect(await result).toBeNull();
    expect(upload).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([20_000, 40_000]);
    expect(RESULT_UPLOAD_BACKOFF_MS).toEqual([20_000, 40_000]);
    expect(logs.at(-1)).toBe('0G Storage upload failed: 503 STORAGE_UNAVAILABLE');
  });

  it('tries again after a network error, a timeout, or a gateway error', async () => {
    const network = () => { throw new TypeError('fetch failed'); };
    const gateway = () => answer(502, 'Bad gateway');
    const timeout = () => answer(504, 'Gateway timeout');
    const { result, upload, logs } = run([network, gateway, stored]);
    expect(await result).toBe(ROOT);
    expect(upload).toHaveBeenCalledTimes(3);
    expect(logs[0]).toContain('no response (fetch failed)');
    expect(await run([timeout, stored]).result).toBe(ROOT);
  });

  it.each([
    ['400', () => answer(400, { success: false, error: { code: 'INVALID_DATA' } })],
    ['401', () => answer(401, { success: false, error: { code: 'INVALID_TOKEN' } })],
    ['429', () => answer(429, { success: false, error: { code: 'RATE_LIMIT' } })],
    ['500', () => answer(500, { success: false, error: { code: 'INTERNAL_ERROR' } })],
    ['a 201 with no rootHash', () => answer(201, { success: true, data: {} })],
  ])('does not try again after %s', async (_label, response) => {
    const { result, upload, sleeps } = run([response, stored]);
    expect(await result).toBeNull();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it("never tries again into the task's deadline, leaving room for one more upload and the submit", async () => {
    // A retry needs its wait, ~90 s for the upload and ~120 s to submit.
    const room = 20_000 + 90_000 + 120_000;
    const late = run([unavailable, stored], { deadlineMs: NOW + room - 1 });
    expect(await late.result).toBeNull();
    expect(late.upload).toHaveBeenCalledTimes(1);
    expect(late.logs[0]).toContain('too close to the task deadline');

    const inTime = run([unavailable, stored], { deadlineMs: NOW + room });
    expect(await inTime.result).toBe(ROOT);

    // The second retry is checked too: 40 s more is past this deadline.
    const tight = run([unavailable, unavailable, stored], { deadlineMs: NOW + 20_000 + 40_000 + 210_000 - 1 });
    expect(await tight.result).toBeNull();
    expect(tight.sleeps).toEqual([20_000]);
  });

  it('retries with no deadline limit when the deadline is unknown', async () => {
    const { result, sleeps } = run([unavailable, unavailable, stored], { deadlineMs: null });
    expect(await result).toBe(ROOT);
    expect(sleeps).toEqual([20_000, 40_000]);
  });
});

describe('isRetryableUploadFailure', () => {
  it('retries storage and network failures only', () => {
    for (const status of [null, 502, 503, 504]) expect(isRetryableUploadFailure(status), String(status)).toBe(true);
    for (const status of [200, 201, 400, 401, 403, 404, 413, 429, 500]) expect(isRetryableUploadFailure(status), String(status)).toBe(false);
  });
});
