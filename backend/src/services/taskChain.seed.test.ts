import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./chain.js', () => ({ baseEscrow: {} }));
vi.mock('./a2aStore.js', () => ({ getMeta: vi.fn(async () => null) }));
vi.mock('./escrowEvents.js', () => ({
  getCachedTaskIdByHash: vi.fn(),
  getTaskIdByHash: vi.fn(),
  seedTaskIdMapping: vi.fn(async () => {}),
}));
vi.mock('./baseEscrowEvents.js', () => ({
  getBaseTaskIdByHash: vi.fn(),
  forceBaseTick: vi.fn(async () => {}),
  seedBaseTaskIdMapping: vi.fn(async () => {}),
}));

import { seedTaskId, resolveTaskByHash } from './taskChain.js';
import { seedTaskIdMapping, getCachedTaskIdByHash } from './escrowEvents.js';
import { seedBaseTaskIdMapping, getBaseTaskIdByHash } from './baseEscrowEvents.js';

const HASH = '0x' + 'ab'.repeat(32);

describe('seedTaskId', () => {
  beforeEach(() => vi.clearAllMocks());

  it('seeds a Base task in the base namespace only', async () => {
    await seedTaskId('base', HASH, '3');
    expect(seedBaseTaskIdMapping).toHaveBeenCalledWith(HASH, '3');
    expect(seedTaskIdMapping).not.toHaveBeenCalled();
  });

  it('seeds a 0G task in the 0G namespace only', async () => {
    await seedTaskId('0g', HASH, 7n);
    expect(seedTaskIdMapping).toHaveBeenCalledWith(HASH, 7n);
    expect(seedBaseTaskIdMapping).not.toHaveBeenCalled();
  });

  // The regression: a Base task seeded only under the 0G keys resolves as 0G
  // until the Base poller catches up, so /accept sent marketplaceAssign to the
  // wrong escrow (NotVerifier on Base Sepolia, task 3).
  it('a Base task known only to the 0G index resolves as 0G — why seeding must target the right chain', async () => {
    vi.mocked(getBaseTaskIdByHash).mockResolvedValue(null);
    vi.mocked(getCachedTaskIdByHash).mockResolvedValue('3');
    expect(await resolveTaskByHash(HASH)).toEqual({ taskId: '3', chain: '0g' });

    vi.mocked(getBaseTaskIdByHash).mockResolvedValue('3');
    expect(await resolveTaskByHash(HASH)).toEqual({ taskId: '3', chain: 'base' });
  });
});
