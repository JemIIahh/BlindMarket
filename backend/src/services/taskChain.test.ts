/**
 * Chain resolution for tasks.
 *
 * Each task resolves to the chain that actually holds it: Base or Arc. The
 * poster picks the hash, so the same hash can be escrowed on both chains;
 * the recorded chain in the meta decides which index is consulted.
 *
 * Run: npx vitest run src/services/taskChain.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getBaseTaskIdByHash = vi.fn();
const getArcTaskIdByHash = vi.fn();
const forceBaseTick = vi.fn(async () => {});
const forceArcTick = vi.fn(async () => {});
const getTaskOn = vi.fn();
const getMeta = vi.fn();
// The escrows just need to be non-null for a branch to be considered; the
// module reads them per call, so a test can switch one off.
const chainMod = vi.hoisted(() => ({ baseEscrow: {} as unknown, arcEscrow: {} as unknown }));

vi.mock('./chain.js', () => chainMod);
// The Arc index is enabled by the registry's Arc escrow; a test can unset it.
const arcEscrow = vi.hoisted(() => ({ current: '0x3600000000000000000000000000000000000000' as string | null }));
vi.mock('./settlementChains.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./settlementChains.js')>();
  return {
    ...mod,
    settlementChainConfig: (key: 'arc' | 'base') => {
      const entry = mod.settlementChainConfig(key);
      return key === 'arc' ? { ...entry, escrowAddress: arcEscrow.current } : entry;
    },
    postingChain: () => (arcEscrow.current ? 'arc' : 'base'),
  };
});
vi.mock('./a2aStore.js', () => ({ getMeta }));
vi.mock('./baseEscrowEvents.js', () => ({ getBaseTaskIdByHash, forceBaseTick }));
vi.mock('./arcEscrowEvents.js', () => ({ getArcTaskIdByHash, forceArcTick }));
vi.mock('./escrow.js', () => ({ getTaskOn }));

const { resolveTaskByHash, resolveCachedTaskByHash, resolveTaskChainById, isIndexedTask, isListedTask } = await import('./taskChain.js');

const HASH = '0xabc';

beforeEach(() => {
  vi.clearAllMocks();
  getBaseTaskIdByHash.mockResolvedValue(null);
  getArcTaskIdByHash.mockResolvedValue(null);
  // Rows indexed before the chain was recorded: every chain is searched.
  getMeta.mockResolvedValue(null);
  chainMod.baseEscrow = {};
  chainMod.arcEscrow = {};
  arcEscrow.current = '0x3600000000000000000000000000000000000000';
});

describe('a task stays on the chain it was indexed on', () => {
  it('resolves a hash escrowed on both chains to the recorded one', async () => {
    getBaseTaskIdByHash.mockResolvedValue('42');
    getArcTaskIdByHash.mockResolvedValue('7');

    getMeta.mockResolvedValue({ chain: 'arc' });
    expect(await resolveTaskByHash(HASH)).toEqual({ taskId: '7', chain: 'arc' });
    expect(await resolveCachedTaskByHash(HASH)).toEqual({ taskId: '7', chain: 'arc' });
    expect(getBaseTaskIdByHash).not.toHaveBeenCalled();

    getMeta.mockResolvedValue({ chain: 'base' });
    expect(await resolveTaskByHash(HASH)).toEqual({ taskId: '42', chain: 'base' });
    expect(await resolveCachedTaskByHash(HASH)).toEqual({ taskId: '42', chain: 'base' });
  });

  it('never falls back to Arc for a task recorded on Base, even when Base has not indexed it yet', async () => {
    getMeta.mockResolvedValue({ chain: 'base' });
    getArcTaskIdByHash.mockResolvedValue('7');

    expect(await resolveTaskByHash(HASH)).toBeNull();
    expect(forceBaseTick).toHaveBeenCalled();
    expect(getArcTaskIdByHash).not.toHaveBeenCalled();
  });

  it('resolves nothing for a task recorded on Base when this backend has no Base escrow', async () => {
    chainMod.baseEscrow = null;
    getMeta.mockResolvedValue({ chain: 'base' });
    getArcTaskIdByHash.mockResolvedValue('7');

    expect(await resolveTaskByHash(HASH)).toBeNull();
    expect(getBaseTaskIdByHash).not.toHaveBeenCalled();
    expect(getArcTaskIdByHash).not.toHaveBeenCalled();
  });

  it('searches every chain when the meta cannot be read', async () => {
    getMeta.mockRejectedValue(new Error('redis down'));
    getBaseTaskIdByHash.mockResolvedValue('42');
    expect(await resolveTaskByHash(HASH)).toEqual({ taskId: '42', chain: 'base' });
  });
});

describe('resolveTaskByHash', () => {
  it('resolves a Base-funded task to the Base chain', async () => {
    getBaseTaskIdByHash.mockResolvedValue('42');
    expect(await resolveTaskByHash(HASH)).toEqual({ taskId: '42', chain: 'base' });
  });

  it('resolves an Arc-funded task to the Arc chain', async () => {
    getArcTaskIdByHash.mockResolvedValue('7');
    expect(await resolveTaskByHash(HASH)).toEqual({ taskId: '7', chain: 'arc' });
  });

  it('forces a Base tick before falling back to the Arc resolver', async () => {
    getBaseTaskIdByHash.mockResolvedValueOnce(null).mockResolvedValueOnce('99');
    expect(await resolveTaskByHash(HASH)).toEqual({ taskId: '99', chain: 'base' });
    expect(forceBaseTick).toHaveBeenCalledOnce();
    expect(forceArcTick).not.toHaveBeenCalled();
  });

  it('falls back to the Arc resolver when Base has nothing', async () => {
    getArcTaskIdByHash.mockResolvedValue('5');
    expect(await resolveTaskByHash(HASH)).toEqual({ taskId: '5', chain: 'arc' });
    expect(getArcTaskIdByHash).toHaveBeenCalledOnce();
  });

  it('returns null when neither chain knows the hash', async () => {
    expect(await resolveTaskByHash(HASH)).toBeNull();
  });
});

describe('resolveTaskChainById', () => {
  const OWNER = '0xX1';
  const OTHER = '0xotherowner';

  const ZERO = '0x0000000000000000000000000000000000000000';
  const on = (chain: string, agent: string) => ({ chain, agent });

  function stubChains(baseAgent: string, arcAgent: string) {
    getTaskOn.mockImplementation(async (chain: string) =>
      on(chain, chain === 'base' ? baseAgent : arcAgent),
    );
  }

  it('picks the chain where the caller is the task agent', async () => {
    stubChains(ZERO, OWNER);
    expect(await resolveTaskChainById(7, OWNER)).toBe('arc');

    stubChains(OWNER, ZERO);
    expect(await resolveTaskChainById(7, OWNER)).toBe('base');
  });

  it('matches ownership case-insensitively', async () => {
    stubChains('0XX1', ZERO);
    expect(await resolveTaskChainById(7, OWNER)).toBe('base');
  });

  it('prefers the posting chain when the same id is owned on both chains', async () => {
    stubChains(OWNER, OWNER);
    expect(await resolveTaskChainById(7, OWNER)).toBe('arc');

    // With no Arc escrow, Base is the posting chain (and the only one searched).
    arcEscrow.current = null;
    expect(await resolveTaskChainById(7, OWNER)).toBe('base');
  });

  it('reads only the chain the client names', async () => {
    stubChains(OWNER, OWNER);
    expect(await resolveTaskChainById(7, OWNER, 'base')).toBe('base');
    expect(getTaskOn).toHaveBeenCalledTimes(1);
    expect(getTaskOn).toHaveBeenCalledWith('base', 7);

    getTaskOn.mockClear();
    expect(await resolveTaskChainById(7, OWNER, 'arc')).toBe('arc');
    expect(getTaskOn).toHaveBeenCalledTimes(1);
    expect(getTaskOn).toHaveBeenCalledWith('arc', 7);
  });

  it('does not fall back to another chain when the named chain is not the caller\'s', async () => {
    // Base id 7 is the caller's, Arc id 7 is someone else's: a refund asked
    // for the Arc task must not be built against the Base one.
    stubChains(OWNER, OTHER);
    expect(await resolveTaskChainById(7, OWNER, 'arc')).toBeNull();
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
    expect(await resolveTaskChainById(7, OWNER)).toBe('arc');
  });
});

describe('the Arc index is only consulted where this stack has an Arc escrow', () => {
  it('skips the Arc resolver for an unindexed hash on a Base-only stack', async () => {
    arcEscrow.current = null;
    const resolved = await resolveTaskByHash(HASH);
    expect(resolved).toBeNull();
    expect(forceBaseTick).toHaveBeenCalled();
    expect(getArcTaskIdByHash).not.toHaveBeenCalled();
  });

  it('consults it where the escrow is configured', async () => {
    getArcTaskIdByHash.mockResolvedValueOnce('7');
    expect(await resolveTaskByHash(HASH)).toEqual({ taskId: '7', chain: 'arc' });
  });
});

describe('a second task funded under the same hash', () => {
  const POSTER = '0x1111111111111111111111111111111111111111';
  const STRANGER = '0x2222222222222222222222222222222222222222';

  beforeEach(() => getMeta.mockResolvedValue({ chain: 'arc', posterAddress: POSTER }));

  it('is not the indexed task: only the id the hash is indexed to is', async () => {
    getArcTaskIdByHash.mockResolvedValue('7');
    expect(await isIndexedTask('arc', 7, HASH)).toBe(true);
    expect(await isIndexedTask('arc', '8', HASH)).toBe(false);
    expect(await isIndexedTask('base', 7, HASH)).toBe(false);
  });

  it('is never read as indexed when the hash has no index entry (a read fails closed)', async () => {
    expect(await isIndexedTask('arc', 7, HASH)).toBe(false);
  });

  it('is skipped by a settlement observer when the index names another task, whoever funded it', async () => {
    getArcTaskIdByHash.mockResolvedValue('7');
    expect(await isListedTask('arc', 7, HASH, POSTER, POSTER)).toBe(true);
    expect(await isListedTask('arc', 8, HASH, POSTER, POSTER)).toBe(false);
  });

  it('with no index entry (evicted), is still the listed task when its on-chain poster listed it', async () => {
    // Case-insensitive: the escrow returns checksummed addresses.
    expect(await isListedTask('arc', 7, HASH, POSTER.toUpperCase().replace('0X', '0x'), POSTER)).toBe(true);
    expect(await isListedTask('arc', 7, HASH, STRANGER, POSTER)).toBe(false);
  });

  it('with no index entry and no listing (no poster on record), has nothing to take over', async () => {
    expect(await isListedTask('arc', 7, HASH, STRANGER, undefined)).toBe(true);
  });
});
