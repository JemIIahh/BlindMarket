import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeError, Wallet } from 'ethers';

const api = vi.hoisted(() => ({ authedGet: vi.fn(), authedPost: vi.fn() }));
vi.mock('./api', () => api);
vi.mock('@privy-io/react-auth', () => ({ getIdentityToken: vi.fn(async () => null), getAccessToken: vi.fn(async () => 'acc') }));
const stash = vi.hoisted(() => ({ stashAesKey: vi.fn() }));
vi.mock('./keyStash', () => stash);

const {
  bytesToHex, prepareBrief, sendFunding, pendingListingRequest, postWithRetry, retryPendingListing,
  uploadBriefs, wrapKeyToExecutors, sealToKeyCustody, postingToken,
} = await import('./postTaskFlow');
const { aesDecrypt, eciesDecrypt, fromBase64, sha256, toBytes } = await import('./crypto');

beforeEach(() => {
  api.authedGet.mockReset();
  api.authedPost.mockReset();
  stash.stashAesKey.mockReset();
});

const SENT = `0x${'5e'.repeat(32)}`;
const TX = `0x${'ab'.repeat(32)}`;

describe('prepareBrief', () => {
  it('posts a public brief as its plaintext, hashed as-is', async () => {
    const { blob, taskHash } = await prepareBrief('Summarise this article', true);
    expect(new TextDecoder().decode(fromBase64(blob))).toBe('Summarise this article');
    expect(taskHash).toBe('0x' + await sha256(toBytes('Summarise this article')));
  });

  it('encrypts a private brief and commits to the ciphertext, which its key decrypts', async () => {
    const { blob, taskHash, key } = await prepareBrief('secret brief', false);
    const ciphertext = fromBase64(blob);
    expect(taskHash).toBe('0x' + await sha256(ciphertext));
    expect(new TextDecoder().decode(await aesDecrypt(ciphertext, key))).toBe('secret brief');
  });

  it('gives the same private brief a fresh key and hash each time', async () => {
    const a = await prepareBrief('same', false);
    const b = await prepareBrief('same', false);
    expect(a.taskHash).not.toBe(b.taskHash);
  });
});

describe('wrapKeyToExecutors', () => {
  it('wraps the key to each executor, skipping a malformed key, and stashes it locally', async () => {
    const agent = Wallet.createRandom();
    const key = new Uint8Array(32).fill(7);
    const wrapped = await wrapKeyToExecutors('0xhash', key, [
      { address: agent.address, publicKey: agent.signingKey.publicKey },
      { address: '0x' + '11'.repeat(20), publicKey: 'not-a-key' },
    ]);
    expect(Object.keys(wrapped)).toEqual([agent.address.toLowerCase()]);
    const unwrapped = await eciesDecrypt(Uint8Array.from(Buffer.from(wrapped[agent.address.toLowerCase()], 'hex')), agent.privateKey);
    expect([...unwrapped]).toEqual([...key]);
    expect(stash.stashAesKey).toHaveBeenCalledWith('0xhash', key);
  });
});

describe('sealToKeyCustody', () => {
  it('seals when custody is on, and is best-effort otherwise', async () => {
    const custody = Wallet.createRandom();
    api.authedGet.mockResolvedValueOnce({ enabled: true, keyId: 'k1', publicKey: custody.signingKey.publicKey, attestation: null });
    const sealed = await sealToKeyCustody(new Uint8Array(32), 'tok');
    expect(sealed?.keyId).toBe('k1');
    api.authedGet.mockResolvedValueOnce({ enabled: false, keyId: null, publicKey: null, attestation: null });
    expect(await sealToKeyCustody(new Uint8Array(32), 'tok')).toBeUndefined();
    api.authedGet.mockRejectedValueOnce(new Error('down'));
    expect(await sealToKeyCustody(new Uint8Array(32), 'tok')).toBeUndefined();
  });
});

describe('sendFunding', () => {
  it('returns a confirmed send as is', async () => {
    const r = await sendFunding(async () => ({ hash: TX, receipt: null }));
    expect(r).toEqual({ sent: { hash: TX, receipt: null }, unconfirmed: false });
  });

  it('turns a failure after broadcast into an unconfirmed send, never an error to retry', async () => {
    const err = Object.assign(makeError('network changed', 'NETWORK_ERROR'), { info: { sendTransactionHash: SENT } });
    const r = await sendFunding(async () => { throw err; });
    expect(r).toEqual({ sent: { hash: SENT, receipt: null }, unconfirmed: true });
  });

  it('rethrows when nothing was broadcast (the wallet refused)', async () => {
    const refused = makeError('user rejected action', 'ACTION_REJECTED');
    await expect(sendFunding(async () => { throw refused; })).rejects.toBe(refused);
  });
});

describe('postWithRetry', () => {
  it('retries and reports the last error when every attempt fails', async () => {
    api.authedPost.mockRejectedValue(new Error('not mined'));
    const { resp, lastErr } = await postWithRetry('/p', {}, 't', { attempts: 3, delayMs: 0 });
    expect(resp).toBeNull();
    expect((lastErr as Error).message).toBe('not mined');
    expect(api.authedPost).toHaveBeenCalledTimes(3);
  });

  it('stops at the first success', async () => {
    api.authedPost.mockRejectedValueOnce(new Error('later')).mockResolvedValueOnce({ onChainTaskId: '7' });
    const { resp } = await postWithRetry<{ onChainTaskId: string }>('/p', {}, 't', { attempts: 3, delayMs: 0 });
    expect(resp).toEqual({ onChainTaskId: '7' });
    expect(api.authedPost).toHaveBeenCalledTimes(2);
  });
});

describe('uploadBriefs', () => {
  it('uploads in one request and keeps the order', async () => {
    api.authedPost.mockResolvedValueOnce({ results: [{ rootHash: 'r1' }, { rootHash: 'r2' }] });
    expect(await uploadBriefs(['a', 'b'], 't')).toEqual(['r1', 'r2']);
    expect(api.authedPost).toHaveBeenCalledWith('/api/v1/storage/upload-batch', { items: [{ data: 'a' }, { data: 'b' }] }, 't');
  });

  it('refuses a short answer rather than pairing briefs with the wrong pointers', async () => {
    api.authedPost.mockResolvedValueOnce({ results: [{ rootHash: 'r1' }] });
    await expect(uploadBriefs(['a', 'b'], 't')).rejects.toThrow('1 of 2');
  });

  it('sends two briefs per request, in order, so no request outlives the edge timeout', async () => {
    api.authedPost.mockImplementation(async (_path: string, body: { items: { data: string }[] }) => ({
      results: body.items.map((it) => ({ rootHash: `r-${it.data}` })),
    }));
    expect(await uploadBriefs(['a', 'b', 'c', 'd', 'e'], 't')).toEqual(['r-a', 'r-b', 'r-c', 'r-d', 'r-e']);
    const sizes = api.authedPost.mock.calls.map((c) => (c[1] as { items: unknown[] }).items.length);
    expect(sizes).toEqual([2, 2, 1]);
  });

  it('retries a pair one brief at a time when storage timed out, keeping the order', async () => {
    const busy = Object.assign(new Error('Brief 2 of 2 couldn’t be stored right now. Nothing was paid'), { status: 503 });
    api.authedPost
      .mockRejectedValueOnce(busy)
      .mockResolvedValueOnce({ results: [{ rootHash: 'r-a' }] })
      .mockResolvedValueOnce({ results: [{ rootHash: 'r-b' }] });
    expect(await uploadBriefs(['a', 'b'], 't')).toEqual(['r-a', 'r-b']);
    expect(api.authedPost).toHaveBeenCalledTimes(3);
  });

  it('does not retry a brief the backend refused', async () => {
    const refused = Object.assign(new Error('1 of 2 briefs is invalid'), { status: 400 });
    api.authedPost.mockRejectedValueOnce(refused);
    await expect(uploadBriefs(['a', 'b'], 't')).rejects.toBe(refused);
    expect(api.authedPost).toHaveBeenCalledTimes(1);
  });
});

describe('pending listing', () => {
  const body = { txHash: TX, taskHash: '0x' + '01'.repeat(32), isUserOp: false, rootHash: 'r' };

  it('lists a single-funded task through the single route with the body as sent', () => {
    expect(pendingListingRequest({ txHash: TX, body })).toEqual({ path: '/api/v1/a2a/tasks/index', body });
  });

  it('lists a batch-funded task through index-batch (its receipt holds several tasks)', () => {
    expect(pendingListingRequest({ txHash: TX, body, route: 'batch' })).toEqual({
      path: '/api/v1/a2a/tasks/index-batch',
      body: { txHash: TX, isUserOp: false, tasks: [{ taskHash: body.taskHash, rootHash: 'r' }] },
    });
  });

  it("surfaces a batch listing's per-task error", async () => {
    api.authedPost.mockResolvedValueOnce({ results: [{ taskHash: body.taskHash, error: { code: 'NOT_IN_RECEIPT', message: 'not in that transaction' } }] });
    await expect(retryPendingListing({ taskHash: body.taskHash, txHash: TX, poster: '0x1', body, at: 0, route: 'batch' })).rejects.toThrow('not in that transaction');
  });

  it('returns the task id a batch listing gives', async () => {
    api.authedPost.mockResolvedValueOnce({ results: [{ taskHash: body.taskHash, onChainTaskId: '41', indexed: true }] });
    expect(await retryPendingListing({ taskHash: body.taskHash, txHash: TX, poster: '0x1', body, at: 0, route: 'batch' })).toEqual({ onChainTaskId: '41' });
  });
});

describe('postingToken and bytesToHex', () => {
  it('falls back to the access token', async () => {
    expect(await postingToken()).toBe('acc');
  });

  it('writes lowercase hex without 0x', () => {
    expect(bytesToHex(new Uint8Array([0, 15, 255]))).toBe('000fff');
  });
});
