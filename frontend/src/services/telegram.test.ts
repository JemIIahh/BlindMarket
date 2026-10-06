import { describe, it, expect, vi } from 'vitest';

vi.mock('../lib/api', () => ({ authedGet: vi.fn(), authedPost: vi.fn(), authedPut: vi.fn(), authedDelete: vi.fn() }));

const { TELEGRAM_TYPE_COPY } = await import('./telegram');

describe('Telegram alert toggles', () => {
  // The backend sends 'disputed' only once a ruling has refunded the poster
  // (disputeListener.ts); nothing is sent when a dispute opens (delta audit
  // 2026-10-06, tg-4).
  it('describes the dispute alert as the ruling it is sent for', () => {
    const { label, description } = TELEGRAM_TYPE_COPY.disputed;
    expect(label).toBe('Dispute ruled');
    expect(description).toMatch(/refunded/i);
    expect(`${label} ${description}`).not.toMatch(/opened|enters dispute/i);
  });
});
