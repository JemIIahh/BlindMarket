/**
 * Which deployment owns a Redis, and whether this process may write shared
 * state on it.
 *
 * A2A keys are shared by every backend on a Redis; a testnet backend pointed
 * at production's once poached a mainnet task. The rules: production is
 * never stopped, whatever it finds; a staging stack claims only a Redis with
 * no other deployment's data (DEPLOYMENT_CLAIM=true takes over on purpose);
 * local development stops only on positive evidence of another deployment.
 *
 * Run: npx vitest run src/services/deploymentIdentity.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

import {
  resolveIdentity, checkDeploymentIdentity, deploymentIdentityStatus, backgroundWritesAllowed,
  _resetIdentityForTests, IDENTITY_KEY, CHECK_TIMEOUT_MS, RETRY_MS, type DeploymentFacts, type Self,
} from './deploymentIdentity.js';
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
const production = (over: Partial<Self> = {}): Self => ({ deploymentId: 'production', facts: PROD, stoppable: false, forceClaim: false, ...over });
const staging = (over: Partial<Self> = {}): Self => ({ deploymentId: 'staging-testnet', facts: STAGING, stoppable: true, forceClaim: false, ...over });
const localDev = (over: Partial<Self> = {}): Self => ({ deploymentId: null, facts: STAGING, stoppable: true, forceClaim: false, ...over });

const NOW = () => new Date('2026-09-19T00:00:00.000Z');
const LATER = () => new Date('2026-09-20T00:00:00.000Z');
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

/** What a staging process on production's Redis could write (the review's B1). */
function plantStagingFingerprints() {
  store.set('a2a:events:escrow', `16602:${STAGING.chains['0g'].escrow}`);
  store.set('base:events:escrow', `84532:${STAGING.chains.base.escrow}`);
}

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  _resetIdentityForTests();
});

describe('production (never stopped)', () => {
  it('claims an empty Redis', async () => {
    const s = await resolveIdentity(redis, production(), NOW);
    expect(s).toEqual({ deploymentId: 'production', role: 'owner', owner: 'production', writersAllowed: true, reason: null });
    expect(record()).toEqual({ id: 'production', ...PROD, claimedAt: NOW().toISOString(), updatedAt: NOW().toISOString() });
  });

  it('claims its Redis even with fingerprints another process planted there, and says so', async () => {
    productionHistory({ fingerprints: false });
    plantStagingFingerprints();
    const s = await resolveIdentity(redis, production(), NOW);
    expect(s).toMatchObject({ role: 'owner', writersAllowed: true });
    expect(s.reason).toMatch(/a2a:events:escrow=16602/);
    expect(s.reason).toMatch(/base:events:escrow=84532:0xbbbb/);
    expect(record().id).toBe('production');
  });

  it('claims its own pre-fingerprint history on its first boot of this release', async () => {
    productionHistory({ fingerprints: false });
    expect(await resolveIdentity(redis, production(), NOW)).toMatchObject({ role: 'owner', writersAllowed: true });
  });

  it('keeps writing when another deployment has claimed its Redis, and says so', async () => {
    await resolveIdentity(redis, staging(), NOW);
    const s = await resolveIdentity(redis, production(), NOW);
    expect(s).toMatchObject({ role: 'not-owner', owner: 'staging-testnet', writersAllowed: true });
    expect(s.reason).toMatch(/production, which is never stopped/);
    expect(record().id).toBe('staging-testnet');
  });

  it('keeps writing without a DEPLOYMENT_ID too', async () => {
    await resolveIdentity(redis, staging(), NOW);
    const s = await resolveIdentity(redis, production({ deploymentId: null }), NOW);
    expect(s).toMatchObject({ role: 'not-owner', writersAllowed: true });
  });

  it('records moving Base Sepolia to Base mainnet, rather than calling it a second deployment', async () => {
    await resolveIdentity(redis, production(), NOW);
    const mainnet: DeploymentFacts = { tier: 'mainnet', chains: { ...PROD.chains, base: { chainId: 8453, escrow: '0x' + '8b'.repeat(20) } } };
    const s = await resolveIdentity(redis, production({ facts: mainnet }), LATER);
    expect(s).toMatchObject({ role: 'owner', writersAllowed: true });
    expect(s.reason).toMatch(/base 84532→8453/);
    expect(record()).toMatchObject({ tier: 'mainnet', chains: mainnet.chains, claimedAt: NOW().toISOString(), updatedAt: LATER().toISOString() });
  });

  it('does not rewrite an unchanged record on restart', async () => {
    await resolveIdentity(redis, production(), NOW);
    redis.set.mockClear();
    expect((await resolveIdentity(redis, production(), LATER)).role).toBe('owner');
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('ignores DEPLOYMENT_CLAIM: it claims anyway, and never overwrites another deployment by accident', async () => {
    await resolveIdentity(redis, staging(), NOW);
    await resolveIdentity(redis, production({ forceClaim: true }), NOW);
    expect(record().id).toBe('staging-testnet');
  });
});

describe('a staging stack (stoppable, with a DEPLOYMENT_ID)', () => {
  it('claims an empty Redis, and owns it on restart', async () => {
    expect(await resolveIdentity(redis, staging(), NOW)).toMatchObject({ role: 'owner', writersAllowed: true });
    expect(await resolveIdentity(redis, staging(), LATER)).toMatchObject({ role: 'owner', writersAllowed: true });
  });

  it("stops its writers on production's claimed Redis, and leaves the record alone", async () => {
    await resolveIdentity(redis, production(), NOW);
    const before = store.get(IDENTITY_KEY);
    const s = await resolveIdentity(redis, staging(), NOW);
    expect(s).toMatchObject({ role: 'not-owner', owner: 'production', writersAllowed: false });
    expect(s.reason).toMatch(/belongs to deployment "production"/);
    expect(store.get(IDENTITY_KEY)).toBe(before);
  });

  it("does not claim a Redis with another deployment's fingerprints, and names every one", async () => {
    productionHistory({ fingerprints: true });
    const s = await resolveIdentity(redis, staging(), NOW);
    expect(s).toMatchObject({ role: 'not-owner', owner: null, writersAllowed: false });
    expect(s.reason).toMatch(/a2a:events:escrow=16661/);
    expect(s.reason).toMatch(/base:events:escrow=84532:0xcca5/);
    expect(s.reason).toMatch(/DEPLOYMENT_CLAIM=true/);
    expect(store.has(IDENTITY_KEY)).toBe(false);
  });

  it("does not claim production's pre-fingerprint history", async () => {
    productionHistory({ fingerprints: false });
    const s = await resolveIdentity(redis, staging(), NOW);
    expect(s).toMatchObject({ role: 'not-owner', writersAllowed: false });
    expect(s.reason).toMatch(/a2a:events:checkpoint with no a2a:events:escrow/);
  });

  it('counts a fingerprint on a chain it does not settle on', async () => {
    store.set('base:events:escrow', `84532:${PROD.chains.base.escrow}`);
    const s = await resolveIdentity(redis, staging({ facts: { tier: 'testnet', chains: { '0g': STAGING.chains['0g'] } } }), NOW);
    expect(s.writersAllowed).toBe(false);
    expect(s.reason).toMatch(/no base escrow/);
  });

  it('claims a Redis whose fingerprints are its own', async () => {
    plantStagingFingerprints();
    expect(await resolveIdentity(redis, staging(), NOW)).toMatchObject({ role: 'owner', writersAllowed: true });
  });

  it('stops when its id comes with other chain ids: another network under the same name', async () => {
    await resolveIdentity(redis, production(), NOW);
    const s = await resolveIdentity(redis, staging({ deploymentId: 'production' }), NOW);
    expect(s).toMatchObject({ role: 'not-owner', owner: 'production', writersAllowed: false });
    expect(s.reason).toMatch(/0g 16661→16602/);
    expect(record().chains['0g'].chainId).toBe(16661);
  });

  it('records an added chain, a redeployed escrow and a tier change', async () => {
    await resolveIdentity(redis, staging(), NOW);
    const arc = { chainId: 5042002, escrow: '0x' + 'a7'.repeat(20) };
    const grown: DeploymentFacts = { tier: 'mainnet', chains: { ...STAGING.chains, base: { chainId: 84532, escrow: '0x' + 'b9'.repeat(20) }, arc } };
    expect(await resolveIdentity(redis, staging({ facts: grown }), LATER)).toMatchObject({ role: 'owner', writersAllowed: true, reason: null });
    expect(record()).toMatchObject({ tier: 'mainnet', chains: grown.chains, updatedAt: LATER().toISOString() });
    // The tier alone is recorded too.
    await resolveIdentity(redis, staging({ facts: { ...grown, tier: 'testnet' } }), NOW);
    expect(record().tier).toBe('testnet');
  });

  describe('DEPLOYMENT_CLAIM=true (one boot)', () => {
    it('takes a Redis over from its record and its index keys', async () => {
      await resolveIdentity(redis, production(), NOW);
      productionHistory({ fingerprints: true });
      const s = await resolveIdentity(redis, staging({ forceClaim: true }), LATER);
      expect(s).toMatchObject({ role: 'owner', writersAllowed: true });
      expect(s.reason).toMatch(/was "production"'s.*Remove DEPLOYMENT_CLAIM/);
      expect(record()).toEqual({ id: 'staging-testnet', ...STAGING, claimedAt: LATER().toISOString(), updatedAt: LATER().toISOString() });
    });

    it('takes back its own record after its chains moved', async () => {
      await resolveIdentity(redis, staging(), NOW);
      const moved: DeploymentFacts = { ...STAGING, chains: { ...STAGING.chains, '0g': { chainId: 16661, escrow: STAGING.chains['0g'].escrow } } };
      expect((await resolveIdentity(redis, staging({ facts: moved }), NOW)).writersAllowed).toBe(false);
      expect((await resolveIdentity(redis, staging({ facts: moved, forceClaim: true }), NOW)).writersAllowed).toBe(true);
      expect((await resolveIdentity(redis, staging({ facts: moved }), NOW)).writersAllowed).toBe(true);
    });
  });
});

describe('local development (stoppable, no DEPLOYMENT_ID)', () => {
  it('never claims, and runs on a Redis with nothing against it', async () => {
    expect(await resolveIdentity(redis, localDev(), NOW)).toEqual({ deploymentId: null, role: 'unset', owner: null, writersAllowed: true, reason: null });
    expect(store.has(IDENTITY_KEY)).toBe(false);
  });

  it('keeps running on an old local Redis (checkpoints with no fingerprint), with a note', async () => {
    productionHistory({ fingerprints: false });
    const s = await resolveIdentity(redis, localDev(), NOW);
    expect(s).toMatchObject({ role: 'unset', writersAllowed: true });
    expect(s.reason).toMatch(/cannot vouch for/);
  });

  it("stops on another deployment's fingerprint", async () => {
    productionHistory({ fingerprints: true });
    expect(await resolveIdentity(redis, localDev(), NOW)).toMatchObject({ role: 'not-owner', writersAllowed: false });
  });

  it("stops on production's record (2026-05-25: a local testnet backend on production's Redis)", async () => {
    await resolveIdentity(redis, production(), NOW);
    const s = await resolveIdentity(redis, localDev(), NOW);
    expect(s).toMatchObject({ role: 'not-owner', owner: 'production', writersAllowed: false });
    expect(s.reason).toMatch(/0g 16661, base 84532/);
  });

  it("runs on a record whose chains are its own (a local stack's own claim)", async () => {
    await resolveIdentity(redis, staging(), NOW);
    expect(await resolveIdentity(redis, localDev(), NOW)).toMatchObject({ role: 'unset', owner: 'staging-testnet', writersAllowed: true });
  });
});

describe('records', () => {
  it('re-reads when another process claims between the read and the write', async () => {
    redis.set.mockImplementationOnce(async () => {
      store.set(IDENTITY_KEY, JSON.stringify({ id: 'production', ...PROD, claimedAt: 'x', updatedAt: 'x' }));
      return null;
    });
    expect(await resolveIdentity(redis, staging(), NOW)).toMatchObject({ role: 'not-owner', owner: 'production', writersAllowed: false });
  });

  it.each([
    ['not json', 'not json'],
    ['no chains', JSON.stringify({ id: 'production' })],
    ['a malformed chain', JSON.stringify({ id: 'production', chains: { base: { chainId: 'x' } } })],
  ])('reports an unreadable record (%s) instead of looping or throwing, and leaves it', async (_label, raw) => {
    store.set(IDENTITY_KEY, raw);
    const s = await resolveIdentity(redis, staging(), NOW);
    expect(s).toMatchObject({ role: 'unknown', writersAllowed: true });
    expect(s.reason).toMatch(/cannot read/);
    expect(store.get(IDENTITY_KEY)).toBe(raw);
  });
});

describe('checkDeploymentIdentity', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps its answer for /health/bridge and the write gates', async () => {
    expect(deploymentIdentityStatus()).toBeNull();
    expect(backgroundWritesAllowed('test writer')).toBe(true);
    await resolveIdentity(redis, production(), NOW);
    const s = await checkDeploymentIdentity(CHECK_TIMEOUT_MS, redis, staging());
    expect(deploymentIdentityStatus()).toEqual(s);
    expect(backgroundWritesAllowed('test writer')).toBe(false);
  });

  it('waits long enough for a slow Redis to answer', async () => {
    const slow = { get: async (k: string) => { await new Promise((r) => setTimeout(r, 50)); return store.get(k) ?? null; }, set: redis.set };
    expect(await checkDeploymentIdentity(undefined, slow, staging())).toMatchObject({ role: 'owner' });
  });

  it('gives up after CHECK_TIMEOUT_MS, lets writes run, and retries until Redis answers', async () => {
    vi.useFakeTimers();
    let up = false;
    const flaky = {
      get: (k: string) => (up ? Promise.resolve(store.get(k) ?? null) : new Promise<string | null>(() => {})),
      set: redis.set,
    };
    const first = checkDeploymentIdentity(undefined, flaky, staging());
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS);
    expect(await first).toMatchObject({ role: 'unknown', writersAllowed: true });
    expect(deploymentIdentityStatus()?.reason).toMatch(/no answer from Redis in 10s/);

    // Redis comes back holding production's record: the retry stops this process.
    store.set(IDENTITY_KEY, JSON.stringify({ id: 'production', ...PROD, claimedAt: 'x', updatedAt: 'x' }));
    up = true;
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(deploymentIdentityStatus()).toMatchObject({ role: 'not-owner', writersAllowed: false });
    expect(backgroundWritesAllowed('test writer')).toBe(false);
  });

  it('lets writes run when Redis errors', async () => {
    const broken = { get: async () => { throw new Error('ECONNREFUSED'); }, set: redis.set };
    const s = await checkDeploymentIdentity(CHECK_TIMEOUT_MS, broken, staging());
    expect(s).toMatchObject({ role: 'unknown', writersAllowed: true });
    expect(s.reason).toMatch(/ECONNREFUSED/);
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
