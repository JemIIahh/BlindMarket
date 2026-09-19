/**
 * The escrow fingerprint on an indexer's Redis keys.
 *
 * Index keys don't name their escrow, so a redeployed escrow or a backend for
 * another network on the same Redis would silently share them. The first run
 * records `<chainId>:<escrow>`; later runs compare and report a mismatch
 * without ever stopping indexing.
 *
 * Run: npx vitest run src/services/escrowFingerprint.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { store, redis } = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    redis: {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      set: vi.fn(async (k: string, v: string, mode?: string) => {
        if (mode === 'NX' && store.has(k)) return null;
        store.set(k, v);
        return 'OK';
      }),
    },
  };
});

vi.mock('./redis.js', () => ({ redis }));

const ESCROW = '0xCca5ab873158b888158AD9Dc36fb4Ee683eFbEBf';
const OTHER = '0xa1F7000000000000000000000000000000000001';

async function load() {
  vi.resetModules();
  return import('./escrowFingerprint.js');
}

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
});

describe('escrow fingerprint', () => {
  it('is written on first run, lowercased and with the chain id', async () => {
    const fp = await load();
    await fp.checkEscrowFingerprint('base', 84532, ESCROW, 0);
    expect(store.get('base:events:escrow')).toBe(`84532:${ESCROW.toLowerCase()}`);
    expect(fp.escrowFingerprintError('base')).toBeNull();
  });

  it('matches regardless of address case', async () => {
    store.set('base:events:escrow', `84532:${ESCROW.toLowerCase()}`);
    const fp = await load();
    await fp.checkEscrowFingerprint('base', 84532, ESCROW.toUpperCase().replace('0X', '0x'), 0);
    expect(fp.escrowFingerprintError('base')).toBeNull();
  });

  it('reports another escrow, and leaves the stored value alone', async () => {
    store.set('base:events:escrow', `84532:${OTHER.toLowerCase()}`);
    const fp = await load();
    await fp.checkEscrowFingerprint('base', 84532, ESCROW, 0);
    expect(fp.escrowFingerprintError('base')).toContain(OTHER.toLowerCase());
    expect(fp.escrowFingerprintError('base')).toContain(ESCROW.toLowerCase());
    expect(store.get('base:events:escrow')).toBe(`84532:${OTHER.toLowerCase()}`);
    expect(fp.escrowFingerprintError('0g')).toBeNull();
  });

  it('reports the same escrow address on another chain', async () => {
    store.set('a2a:events:escrow', `16602:${ESCROW.toLowerCase()}`);
    const fp = await load();
    await fp.checkEscrowFingerprint('0g', 16661, ESCROW, 0);
    expect(fp.escrowFingerprintError('0g')).toMatch(/16602:.*16661:/);
  });

  it('rechecks at most once a minute and clears once the keys match again', async () => {
    store.set('base:events:escrow', `84532:${OTHER.toLowerCase()}`);
    const fp = await load();
    await fp.checkEscrowFingerprint('base', 84532, ESCROW, 0);
    expect(fp.escrowFingerprintError('base')).not.toBeNull();

    store.set('base:events:escrow', `84532:${ESCROW.toLowerCase()}`);
    await fp.checkEscrowFingerprint('base', 84532, ESCROW, 30_000);
    expect(fp.escrowFingerprintError('base')).not.toBeNull();
    expect(redis.set).toHaveBeenCalledTimes(1);

    await fp.checkEscrowFingerprint('base', 84532, ESCROW, 60_000);
    expect(fp.escrowFingerprintError('base')).toBeNull();
  });

  it.each([undefined, null, '', '0x0000000000000000000000000000000000000000'])(
    'does nothing without an escrow (%j)',
    async (escrow) => {
      const fp = await load();
      await fp.checkEscrowFingerprint('base', 84532, escrow, 0);
      expect(redis.set).not.toHaveBeenCalled();
    },
  );

  it('never throws, and retries on the next call after a Redis failure', async () => {
    const fp = await load();
    redis.set.mockRejectedValueOnce(new Error('redis down'));
    await expect(fp.checkEscrowFingerprint('base', 84532, ESCROW, 0)).resolves.toBeUndefined();
    await fp.checkEscrowFingerprint('base', 84532, ESCROW, 1);
    expect(store.get('base:events:escrow')).toBe(`84532:${ESCROW.toLowerCase()}`);
  });
});
