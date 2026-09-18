/**
 * Which deployment owns a Redis, and whether this process's background
 * writers may run on it.
 *
 * A2A keys are shared by every backend on a Redis; a testnet backend pointed
 * at production's once poached a mainnet task. The first deployment with a
 * DEPLOYMENT_ID claims an unclaimed Redis; one that disagrees with the owner
 * stops only its own writers; the owner, and a process with no id, are never
 * stopped.
 *
 * Run: npx vitest run src/services/deploymentIdentity.test.ts
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
        return 'OK' as const;
      }),
    },
  };
});
vi.mock('./redis.js', () => ({ redis }));

import { resolveIdentity, checkDeploymentIdentity, IDENTITY_KEY, type DeploymentFacts } from './deploymentIdentity.js';
import { parseDeploymentId } from '../config.js';

const PROD: DeploymentFacts = {
  tier: null,
  chains: {
    '0g': { chainId: 16661, escrow: '0x3d0374963daad43e31d42373eb11156a8e8ce2ff' },
    base: { chainId: 84532, escrow: '0xcca5ab873158b888158ad9dc36fb4ee683efbebf' },
  },
};
const STAGING: DeploymentFacts = {
  tier: 'testnet',
  chains: {
    '0g': { chainId: 16602, escrow: '0x0a0a000000000000000000000000000000000002' },
    base: { chainId: 84532, escrow: '0xbbbb000000000000000000000000000000000001' },
  },
};
const NOW = () => new Date('2026-09-19T00:00:00.000Z');
const record = () => JSON.parse(store.get(IDENTITY_KEY) ?? 'null');

/** A Redis production has been writing to: indexer checkpoints, and fingerprints from this release on. */
function productionHistory({ fingerprints }: { fingerprints: boolean }) {
  store.set('a2a:events:checkpoint', '33500000');
  store.set('base:events:checkpoint', '46300000');
  if (fingerprints) {
    store.set('a2a:events:escrow', `16661:${PROD.chains['0g'].escrow}`);
    store.set('base:events:escrow', `84532:${PROD.chains.base.escrow}`);
  }
}

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});

describe('a process with a DEPLOYMENT_ID', () => {
  it('claims an empty Redis and owns it', async () => {
    const s = await resolveIdentity(redis, 'staging-testnet', STAGING, true, NOW);
    expect(s).toEqual({ deploymentId: 'staging-testnet', role: 'owner', owner: 'staging-testnet', writersAllowed: true, reason: null });
    expect(record()).toEqual({ id: 'staging-testnet', ...STAGING, claimedAt: NOW().toISOString(), updatedAt: NOW().toISOString() });
  });

  it('stays the owner on restart, and records its redeployed escrow', async () => {
    await resolveIdentity(redis, 'staging-testnet', STAGING, true, NOW);
    const redeployed: DeploymentFacts = { ...STAGING, chains: { ...STAGING.chains, base: { chainId: 84532, escrow: '0xbbbb000000000000000000000000000000000009' } } };
    const later = () => new Date('2026-09-20T00:00:00.000Z');
    const s = await resolveIdentity(redis, 'staging-testnet', redeployed, true, later);
    expect(s.role).toBe('owner');
    expect(s.writersAllowed).toBe(true);
    expect(record().chains.base.escrow).toBe('0xbbbb000000000000000000000000000000000009');
    expect(record().claimedAt).toBe(NOW().toISOString());
    expect(record().updatedAt).toBe(later().toISOString());
  });

  it('keeps running, but leaves the record alone, when its id comes with other chain ids', async () => {
    await resolveIdentity(redis, 'production', PROD, false, NOW);
    const before = store.get(IDENTITY_KEY);
    const s = await resolveIdentity(redis, 'production', STAGING, true, NOW);
    expect(s.role).toBe('owner');
    expect(s.writersAllowed).toBe(true);
    expect(s.reason).toMatch(/two deployments may share this DEPLOYMENT_ID/);
    expect(store.get(IDENTITY_KEY)).toBe(before);
  });

  it('stops only its own writers when the Redis belongs to another deployment', async () => {
    await resolveIdentity(redis, 'production', PROD, false, NOW);
    const before = store.get(IDENTITY_KEY);
    const s = await resolveIdentity(redis, 'staging-testnet', STAGING, true, NOW);
    expect(s).toMatchObject({ role: 'not-owner', owner: 'production', writersAllowed: false });
    expect(s.reason).toMatch(/belongs to deployment "production"/);
    expect(store.get(IDENTITY_KEY)).toBe(before);
    // The owner is unaffected by that.
    expect((await resolveIdentity(redis, 'production', PROD, false, NOW)).writersAllowed).toBe(true);
  });

  it("does not claim a Redis carrying another escrow's fingerprint", async () => {
    productionHistory({ fingerprints: true });
    const s = await resolveIdentity(redis, 'staging-testnet', STAGING, false, NOW);
    expect(s).toMatchObject({ role: 'not-owner', owner: null, writersAllowed: false });
    expect(s.reason).toMatch(/a2a:events:escrow is 16661:0x3d03/);
    expect(s.reason).toMatch(/delete a2a:events:escrow and restart/);
    expect(store.has(IDENTITY_KEY)).toBe(false);
  });

  it('counts a fingerprint on a chain it does not settle on as foreign', async () => {
    store.set('base:events:escrow', `84532:${PROD.chains.base.escrow}`);
    const ogOnly: DeploymentFacts = { tier: 'testnet', chains: { '0g': STAGING.chains['0g'] } };
    const s = await resolveIdentity(redis, 'staging-testnet', ogOnly, true, NOW);
    expect(s.writersAllowed).toBe(false);
    expect(s.reason).toMatch(/no base escrow here/);
  });

  it('claims a Redis whose fingerprints are its own (it ran this release before setting an id)', async () => {
    productionHistory({ fingerprints: true });
    const s = await resolveIdentity(redis, 'production', PROD, false, NOW);
    expect(s.role).toBe('owner');
    expect(record().id).toBe('production');
  });

  describe('indexer checkpoints with no fingerprint (a Redis from before this release)', () => {
    it('are taken as its own history by a process that is not strict: production claims its Redis', async () => {
      productionHistory({ fingerprints: false });
      const s = await resolveIdentity(redis, 'production', PROD, false, NOW);
      expect(s).toMatchObject({ role: 'owner', writersAllowed: true });
      expect(record().id).toBe('production');
    });

    it('are not claimed by a strict (staging) process', async () => {
      productionHistory({ fingerprints: false });
      const s = await resolveIdentity(redis, 'staging-testnet', STAGING, true, NOW);
      expect(s).toMatchObject({ role: 'not-owner', writersAllowed: false });
      expect(s.reason).toMatch(/a2a:events:checkpoint is set with no escrow fingerprint/);
      expect(store.has(IDENTITY_KEY)).toBe(false);
    });
  });

  it('re-reads when another process claims between its read and its write', async () => {
    redis.set.mockImplementationOnce(async () => {
      store.set(IDENTITY_KEY, JSON.stringify({ id: 'production', ...PROD, claimedAt: 'x', updatedAt: 'x' }));
      return null;
    });
    const s = await resolveIdentity(redis, 'staging-testnet', STAGING, true, NOW);
    expect(s).toMatchObject({ role: 'not-owner', owner: 'production', writersAllowed: false });
  });

  it('reports an unreadable record instead of looping on it, and leaves it in place', async () => {
    store.set(IDENTITY_KEY, 'not json');
    const s = await resolveIdentity(redis, 'staging-testnet', STAGING, true, NOW);
    expect(s).toMatchObject({ role: 'unknown', writersAllowed: true });
    expect(s.reason).toMatch(/deployment:identity holds a value this release cannot read/);
    expect(store.get(IDENTITY_KEY)).toBe('not json');
  });
});

describe('a process with no DEPLOYMENT_ID', () => {
  it('never claims and is never stopped', async () => {
    productionHistory({ fingerprints: true });
    const s = await resolveIdentity(redis, null, STAGING, true, NOW);
    expect(s).toEqual({ deploymentId: null, role: 'unset', owner: null, writersAllowed: true, reason: null });
    expect(store.has(IDENTITY_KEY)).toBe(false);
  });

  it('says so when the recorded owner runs on other chains', async () => {
    await resolveIdentity(redis, 'production', PROD, false, NOW);
    const s = await resolveIdentity(redis, null, STAGING, false, NOW);
    expect(s).toMatchObject({ role: 'unset', owner: 'production', writersAllowed: true });
    expect(s.reason).toMatch(/belongs to deployment "production", whose chains differ/);
    const same = await resolveIdentity(redis, null, PROD, false, NOW);
    expect(same.reason).toBeNull();
  });
});

describe('checkDeploymentIdentity at boot', () => {
  it('lets the writers run when Redis fails, rather than stop an owner on a blip', async () => {
    redis.get.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const s = await checkDeploymentIdentity();
    expect(s).toMatchObject({ role: 'unknown', writersAllowed: true });
    expect(s.reason).toMatch(/ECONNREFUSED/);
  });

  it('gives up waiting on a Redis that never answers', async () => {
    redis.get.mockImplementationOnce(() => new Promise(() => {}));
    const s = await checkDeploymentIdentity(20);
    expect(s).toMatchObject({ role: 'unknown', writersAllowed: true });
    expect(s.reason).toMatch(/no answer from Redis/);
  });
});

describe('DEPLOYMENT_ID', () => {
  it.each([
    [undefined, null],
    ['', null],
    ['  ', null],
    ['production', 'production'],
    [' staging-testnet ', 'staging-testnet'],
    ['arc.v2_1', 'arc.v2_1'],
  ])('%j reads as %j', (raw, expected) => {
    expect(parseDeploymentId(raw)).toBe(expected);
  });

  it.each(['Production', 'staging testnet', '-x', 'a'.repeat(65), 'prod/1'])('%j fails at load', (raw) => {
    expect(() => parseDeploymentId(raw)).toThrow(/not a deployment name/);
  });
});
