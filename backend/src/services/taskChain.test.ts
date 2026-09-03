/**
 * Chain resolution for tasks.
 *
 * Task creation moved to Base while the finalize and refund paths still
 * resolved ids through the 0G index alone, so a Base-funded task 503'd
 * forever and could never be settled or refunded. These tests pin the
 * routing: each task resolves to the chain that actually holds it, and the
 * expensive 0G slow path is not paid for a task that lives on Base.
 *
 * Run: npx vitest run src/services/taskChain.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getCachedTaskIdByHash = vi.fn();
const getTaskIdByHash = vi.fn();
const getBaseTaskIdByHash = vi.fn();
const forceBaseTick = vi.fn(async () => {});
const getTaskOn = vi.fn();

// baseEscrow just needs to be non-null for the Base branch to be considered.
vi.mock('./chain.js', () => ({ baseEscrow: {} }));
vi.mock('./escrowEvents.js', () => ({ getCachedTaskIdByHash, getTaskIdByHash }));
vi.mock('./baseEscrowEvents.js', () => ({ getBaseTaskIdByHash, forceBaseTick }));
vi.mock('./escrow.js', () => ({ getTaskOn }));

const { resolveTaskByHash, resolveTaskChainById } = await import('./taskChain.js');

const HASH = '0xabc';

beforeEach(() => {
  vi.clearAllMocks();
  getCachedTaskIdByHash.mockResolvedValue(null);
  getTaskIdByHash.mockResolvedValue(null);
  getBaseTaskIdByHash.mockResolvedValue(null);
});

describe('resolveTaskByHash', () => {
  it('resolves a Base-funded task to the Base chain', async () => {
    getBaseTaskIdByHash.mockResolvedValue('42');

    expect(await resolveTaskByHash(HASH)).toEqual({ taskId: '42', chain: 'base' });
  });

  it('resolves a 0G-funded task to the 0G chain', async () => {
    getCachedTaskIdByHash.mockResolvedValue('7');

    expect(await resolveTaskByHash(HASH)).toEqual({ taskId: '7', chain: '0g' });
  });

  it('never pays the 0G slow path for a task that is on Base', async () => {
    // getTaskIdByHash retries for ~6s and can trigger an 850k-block backfill.
    getBaseTaskIdByHash.mockResolvedValue('42');

    await resolveTaskByHash(HASH);

    expect(getTaskIdByHash).not.toHaveBeenCalled();
  });

  it('forces a Base tick before falling back to the 0G resolver', async () => {
    // Nothing cached yet — a create tx that just confirmed.
    getBaseTaskIdByHash.mockResolvedValueOnce(null).mockResolvedValueOnce('99');

    expect(await resolveTaskByHash(HASH)).toEqual({ taskId: '99', chain: 'base' });
    expect(forceBaseTick).toHaveBeenCalledOnce();
    expect(getTaskIdByHash).not.toHaveBeenCalled();
  });

  it('falls back to the 0G resolver when Base has nothing', async () => {
    getTaskIdByHash.mockResolvedValue('5');

    expect(await resolveTaskByHash(HASH)).toEqual({ taskId: '5', chain: '0g' });
    expect(getTaskIdByHash).toHaveBeenCalledOnce();
  });

  it('returns null when neither chain knows the hash', async () => {
    expect(await resolveTaskByHash(HASH)).toBeNull();
  });
});

describe('resolveTaskChainById', () => {
  const OWNER = '0xX1';
  const OTHER = '0xotherowner';

  // Reading an id that was never created returns a zero-filled struct rather
  // than reverting, so the zero address stands in for "not on this chain".
  const ZERO = '0x0000000000000000000000000000000000000000';
  const on = (chain: string, agent: string) => ({ chain, agent });

  function stubChains(baseAgent: string, ogAgent: string) {
    getTaskOn.mockImplementation(async (chain: string) =>
      on(chain, chain === 'base' ? baseAgent : ogAgent),
    );
  }

  it('picks the chain where the caller is the task agent', async () => {
    stubChains(ZERO, OWNER);
    expect(await resolveTaskChainById(7, OWNER)).toBe('0g');

    stubChains(OWNER, ZERO);
    expect(await resolveTaskChainById(7, OWNER)).toBe('base');
  });

  it('matches ownership case-insensitively', async () => {
    stubChains('0XX1', ZERO);
    expect(await resolveTaskChainById(7, OWNER)).toBe('base');
  });

  it('prefers Base when the same id is owned on both chains', async () => {
    // Ids are per-contract counters, so a collision is possible; the newer
    // task is the one on the settlement chain.
    stubChains(OWNER, OWNER);
    expect(await resolveTaskChainById(7, OWNER)).toBe('base');
  });

  it('returns null when the caller owns the id on neither chain', async () => {
    stubChains(OTHER, OTHER);
    expect(await resolveTaskChainById(7, OWNER)).toBeNull();
  });

  it('survives a chain read that throws', async () => {
    getTaskOn.mockImplementation(async (chain: string) => {
      if (chain === 'base') throw new Error('RPC down');
      return on(chain, OWNER);
    });

    expect(await resolveTaskChainById(7, OWNER)).toBe('0g');
  });
});
