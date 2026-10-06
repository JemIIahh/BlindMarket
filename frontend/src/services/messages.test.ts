import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/api', () => ({ authedGet: vi.fn(), authedPost: vi.fn(), authedPut: vi.fn(), authedDelete: vi.fn() }));

const { authedGet } = await import('../lib/api');
const { unreadMessageCount } = await import('./messages');

describe('unreadMessageCount', () => {
  beforeEach(() => vi.mocked(authedGet).mockReset());

  // The backend answers { unread } (routes/messages.ts). The sidebar badge read
  // `count`, so a real unread message never showed.
  it('reads the unread field the API sends', async () => {
    vi.mocked(authedGet).mockResolvedValue({ unread: 3 });
    await expect(unreadMessageCount()).resolves.toBe(3);
    expect(authedGet).toHaveBeenCalledWith('/api/v1/messages/unread-count');
  });

  it('is 0 when the field is missing', async () => {
    vi.mocked(authedGet).mockResolvedValue({});
    await expect(unreadMessageCount()).resolves.toBe(0);
  });
});
