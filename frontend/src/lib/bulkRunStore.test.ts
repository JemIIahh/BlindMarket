import { beforeEach, describe, expect, it } from 'vitest';
import { MAYBE_PAID, clearRun, isSendable, loadRun, mayRequeue, saveRun, settleInFlight, type StoredRun } from './bulkRunStore';

class MemoryStorage {
  rows = new Map<string, string>();
  get length() { return this.rows.size; }
  key(i: number) { return [...this.rows.keys()][i] ?? null; }
  getItem(k: string) { return this.rows.get(k) ?? null; }
  setItem(k: string, v: string) { this.rows.set(k, v); }
  removeItem(k: string) { this.rows.delete(k); }
  clear() { this.rows.clear(); }
}

beforeEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
});

const run = (statuses: StoredRun['statuses']): StoredRun => ({ v: 1, startedAt: 1, updatedAt: 1, statuses });

describe('bulk run store', () => {
  it('saves per wallet, case-insensitively, and clears', () => {
    saveRun('0xABC', run({ fp1: { row: 1, state: 'done', taskHash: '0xh' } }));
    expect(loadRun('0xabc')?.statuses.fp1.state).toBe('done');
    expect(loadRun('0xdef')).toBeNull();
    clearRun('0xAbc');
    expect(loadRun('0xabc')).toBeNull();
  });

  it('drops a run older than a week, and a corrupt one', () => {
    localStorage.setItem('blindmarket:bulkRun:0xold', JSON.stringify({ ...run({}), updatedAt: Date.now() - 8 * 24 * 3600 * 1000 }));
    expect(loadRun('0xold')).toBeNull();
    localStorage.setItem('blindmarket:bulkRun:0xbad', '{not json');
    expect(loadRun('0xbad')).toBeNull();
  });

  it('never stores a brief: only statuses', () => {
    saveRun('0x1', run({ fp1: { row: 1, state: 'queued' } }));
    expect(localStorage.getItem('blindmarket:bulkRun:0x1')).not.toContain('instructions');
  });

  it('says whether the run was saved, so a sending mark that did not save sends nothing', () => {
    expect(saveRun('0x1', run({ fp1: { row: 1, state: 'sending', taskHash: '0xh' } }))).toBe(true);
    (globalThis as { localStorage?: unknown }).localStorage = { setItem: () => { throw new Error('QuotaExceededError'); } };
    expect(saveRun('0x1', run({ fp1: { row: 1, state: 'sending', taskHash: '0xh' } }))).toBe(false);
  });
});

describe('settleInFlight', () => {
  it('re-queues a row that was only being prepared', () => {
    expect(settleInFlight({ a: { row: 1, state: 'preparing' } }).a).toEqual({ row: 1, state: 'queued' });
  });

  it('treats a row paid for with a known hash as funded but not listed', () => {
    for (const state of ['sending', 'listing'] as const) {
      const s = settleInFlight({ a: { row: 1, state, txHash: '0xt', taskHash: '0xh' } }).a;
      expect(s).toMatchObject({ state: 'unlisted', txHash: '0xt', taskHash: '0xh' });
      expect(isSendable(s)).toBe(false);
    }
  });

  it("marks a row left in 'sending' with no hash as may-have-been-paid, never re-sent automatically", () => {
    const s = settleInFlight({ a: { row: 1, state: 'sending', taskHash: '0xh' } }).a;
    expect(s).toEqual({ row: 1, state: 'unknown', taskHash: '0xh', error: MAYBE_PAID });
    expect(s.error).toContain('May have been paid');
    expect(s.error).toContain('Check My tasks before posting it again');
    expect(isSendable(s)).toBe(false);
  });

  it("keeps the engine's words for a row it left 'sending' when the wallet failed without a hash", () => {
    const why = 'May have been paid: the wallet stopped without saying whether it sent this. Check My tasks before posting it again. (socket hang up)';
    const s = settleInFlight({ a: { row: 1, state: 'sending', taskHash: '0xh', error: why } }).a;
    expect(s).toEqual({ row: 1, state: 'unknown', taskHash: '0xh', error: why });
    expect(mayRequeue(s)).toBe(true);
  });

  it("re-queues a row whose transaction was only being built ('funding'): the wallet never had it", () => {
    expect(settleInFlight({ a: { row: 1, state: 'funding', taskHash: '0xh' } }).a).toEqual({ row: 1, state: 'queued' });
  });

  it('lets the poster queue again by hand only a row with an unknown payment and no transaction hash', () => {
    expect(mayRequeue({ row: 1, state: 'unknown', taskHash: '0xh', error: MAYBE_PAID })).toBe(true);
    // The wallet broadcast it: check the transaction, never pay again from here.
    expect(mayRequeue({ row: 1, state: 'unknown', txHash: '0xt' })).toBe(false);
    for (const state of ['queued', 'sending', 'unlisted', 'done', 'failed'] as const) expect(mayRequeue({ row: 1, state })).toBe(false);
    expect(mayRequeue(undefined)).toBe(false);
  });

  it('only lets queued, failed or new rows be sent again', () => {
    expect(isSendable(undefined)).toBe(true);
    expect(isSendable({ row: 1, state: 'queued' })).toBe(true);
    expect(isSendable({ row: 1, state: 'failed' })).toBe(true);
    for (const state of ['done', 'unlisted', 'unknown', 'funding', 'sending', 'listing'] as const) {
      expect(isSendable({ row: 1, state })).toBe(false);
    }
  });
});
