/**
 * Which deployment owns a Redis, and whether this process may write shared
 * state on it.
 *
 * A2A keys are shared by every backend on a Redis; a testnet backend pointed
 * at production's once poached a mainnet task. The rules: production is
 * never stopped, whatever it finds, and takes its Redis back; a staging stack
 * claims only a Redis with no other deployment's data, writes nothing until it
 * knows, and takes one over only from the owner DEPLOYMENT_CLAIM names; local
 * development stops on evidence of another network.
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
const sentry = vi.hoisted(() => ({ captureMessage: vi.fn() }));
vi.mock('@sentry/node', () => sentry);

import {
  resolveIdentity, checkDeploymentIdentity, deploymentIdentityStatus, backgroundWritesAllowed, onBackgroundWritesStopped,
  _resetIdentityForTests, IDENTITY_KEY, CHECK_TIMEOUT_MS, RETRY_MS, type DeploymentFacts, type Self,
} from './deploymentIdentity.js';
import { parseDeploymentId, parseDeploymentClaim } from '../config.js';

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
const production = (over: Partial<Self> = {}): Self => ({ deploymentId: 'production', facts: PROD, stoppable: false, claim: null, ...over });
const staging = (over: Partial<Self> = {}): Self => ({ deploymentId: 'staging-testnet', facts: STAGING, stoppable: true, claim: null, ...over });
const localDev = (over: Partial<Self> = {}): Self => ({ deploymentId: null, facts: STAGING, stoppable: true, claim: null, ...over });

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

/** An older staging stack's claim, for takeover tests. */
const localDevStackClaim = () => staging({ deploymentId: 'old-staging' });

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
    expect(s).toEqual({ deploymentId: 'production', role: 'owner', owner: 'production', writersAllowed: true, stoppable: false, reason: null });
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

  it('claims its own pre-fingerprint history on its first boot of this release, as its own', async () => {
    productionHistory({ fingerprints: false });
    const s = await resolveIdentity(redis, production(), NOW);
    expect(s).toMatchObject({ role: 'owner', writersAllowed: true });
    expect(s.reason).toMatch(/taking its unfingerprinted index state as this deployment's own history/);
  });

  it('takes its Redis back from any other deployment that claimed it', async () => {
    await resolveIdentity(redis, staging(), NOW);
    const s = await resolveIdentity(redis, production(), LATER);
    expect(s).toMatchObject({ role: 'owner', owner: 'production', writersAllowed: true });
    expect(s.reason).toMatch(/took this Redis back from deployment "staging-testnet"/);
    expect(record()).toEqual({ id: 'production', ...PROD, claimedAt: LATER().toISOString(), updatedAt: LATER().toISOString() });
    // And the staging stack stops at its next check.
    expect(await resolveIdentity(redis, staging(), LATER, { first: false })).toMatchObject({ role: 'not-owner', writersAllowed: false });
  });

  it('keeps writing without a DEPLOYMENT_ID, and says whose Redis this is', async () => {
    await resolveIdentity(redis, staging(), NOW);
    const s = await resolveIdentity(redis, production({ deploymentId: null }), NOW);
    expect(s).toMatchObject({ role: 'not-owner', writersAllowed: true });
    expect(s.reason).toMatch(/never stopped/);
    expect(record().id).toBe('staging-testnet');
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

  it('needs no DEPLOYMENT_CLAIM: a value set on it changes nothing', async () => {
    productionHistory({ fingerprints: true });
    const s = await resolveIdentity(redis, production({ claim: 'staging-testnet' }), NOW);
    expect(s).toMatchObject({ role: 'owner', writersAllowed: true });
    expect(s.reason).toBeNull();
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
    expect(s.reason).toMatch(/DEPLOYMENT_CLAIM=unclaimed/);
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

  describe('DEPLOYMENT_CLAIM (first check only, from the owner it names)', () => {
    it('takes a Redis over from the owner it names', async () => {
      await resolveIdentity(redis, localDevStackClaim(), NOW);
      productionHistory({ fingerprints: true });
      const s = await resolveIdentity(redis, staging({ claim: 'old-staging' }), LATER);
      expect(s).toMatchObject({ role: 'owner', writersAllowed: true });
      expect(s.reason).toMatch(/was "old-staging"'s.*Remove DEPLOYMENT_CLAIM/);
      expect(record()).toEqual({ id: 'staging-testnet', ...STAGING, claimedAt: LATER().toISOString(), updatedAt: LATER().toISOString() });
    });

    it('cannot take a different Redis: a value left in the environment is ignored there', async () => {
      await resolveIdentity(redis, production(), NOW);
      const s = await resolveIdentity(redis, staging({ claim: 'old-staging' }), LATER);
      expect(s).toMatchObject({ role: 'not-owner', owner: 'production', writersAllowed: false });
      expect(s.reason).toMatch(/DEPLOYMENT_CLAIM=old-staging ignored: this Redis is "production"'s/);
      expect(record().id).toBe('production');
    });

    it('"unclaimed" takes a Redis with no record despite its index keys, and nothing else', async () => {
      productionHistory({ fingerprints: false });
      expect(await resolveIdentity(redis, staging({ claim: 'unclaimed' }), NOW)).toMatchObject({ role: 'owner', writersAllowed: true });
      store.clear();
      await resolveIdentity(redis, production(), NOW);
      expect(await resolveIdentity(redis, staging({ claim: 'unclaimed' }), NOW)).toMatchObject({ role: 'not-owner', writersAllowed: false });
    });

    it('counts on the first check only, so it cannot fight a production that took the Redis back', async () => {
      await resolveIdentity(redis, production(), NOW);
      const first = await resolveIdentity(redis, staging({ claim: 'production' }), NOW, { first: true });
      expect(first.writersAllowed).toBe(true); // named on purpose — a human's decision
      await resolveIdentity(redis, production(), LATER);
      const later = await resolveIdentity(redis, staging({ claim: 'production' }), LATER, { first: false });
      expect(later).toMatchObject({ role: 'not-owner', writersAllowed: false });
      expect(record().id).toBe('production');
    });

    it('takes back its own record after its chains moved', async () => {
      await resolveIdentity(redis, staging(), NOW);
      const moved: DeploymentFacts = { ...STAGING, chains: { ...STAGING.chains, '0g': { chainId: 16661, escrow: STAGING.chains['0g'].escrow } } };
      expect((await resolveIdentity(redis, staging({ facts: moved }), NOW)).writersAllowed).toBe(false);
      expect((await resolveIdentity(redis, staging({ facts: moved, claim: 'staging-testnet' }), NOW)).writersAllowed).toBe(true);
      expect((await resolveIdentity(redis, staging({ facts: moved }), NOW)).writersAllowed).toBe(true);
    });
  });
});

describe('local development (stoppable, no DEPLOYMENT_ID)', () => {
  it('never claims, and runs on a Redis with nothing against it', async () => {
    expect(await resolveIdentity(redis, localDev(), NOW)).toEqual({ deploymentId: null, role: 'unset', owner: null, writersAllowed: true, stoppable: true, reason: null });
    expect(store.has(IDENTITY_KEY)).toBe(false);
  });

  it('keeps running on an old local Redis (checkpoints with no fingerprint), with a note', async () => {
    productionHistory({ fingerprints: false });
    const s = await resolveIdentity(redis, localDev(), NOW);
    expect(s).toMatchObject({ role: 'unset', writersAllowed: true });
    expect(s.reason).toMatch(/cannot vouch for/);
  });

  it("stops on another network's fingerprint, and names the keys to delete if the Redis is its own", async () => {
    productionHistory({ fingerprints: true });
    const s = await resolveIdentity(redis, localDev(), NOW);
    expect(s).toMatchObject({ role: 'not-owner', writersAllowed: false });
    expect(s.reason).toMatch(/a2a:events:escrow=16661/);
    expect(s.reason).toMatch(/delete a2a:events:escrow, base:events:escrow and restart/);
  });

  it('only notes a fingerprint for another escrow on its own chain (an earlier local run)', async () => {
    store.set('base:events:escrow', '84532:0xa1f75b5ec92f4485d4eefa339dc2b8af25df0ec5');
    const s = await resolveIdentity(redis, localDev(), NOW);
    expect(s).toMatchObject({ role: 'unset', writersAllowed: true });
    expect(s.reason).toMatch(/if it is left from an earlier run, delete base:events:escrow/);
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

  it('writes nothing in a stoppable process until its first check answers (the review\'s B2a)', async () => {
    let answer: (v: string | null) => void = () => {};
    const slow = { get: vi.fn((_k: string) => new Promise<string | null>((r) => { answer = r; })), set: redis.set };
    const pending = checkDeploymentIdentity(CHECK_TIMEOUT_MS, slow, staging());
    expect(backgroundWritesAllowed('forced indexer pass')).toBe(false);
    answer(null);
    // Unblock the remaining reads (fingerprints, checkpoints) of an empty Redis.
    slow.get.mockImplementation(async (k: string) => store.get(k) ?? null);
    expect(await pending).toMatchObject({ role: 'owner' });
    expect(backgroundWritesAllowed('forced indexer pass')).toBe(true);
  });

  it('never holds production back while its check runs', async () => {
    const slow = { get: () => new Promise<string | null>(() => {}), set: redis.set };
    void checkDeploymentIdentity(CHECK_TIMEOUT_MS, slow, production());
    expect(backgroundWritesAllowed('0G indexer')).toBe(true);
  });

  it('re-checks every RETRY_MS: a staging owner stops once production takes its Redis back, and its workers are stopped', async () => {
    vi.useFakeTimers();
    const stopped = vi.fn();
    onBackgroundWritesStopped(stopped);
    expect(await checkDeploymentIdentity(CHECK_TIMEOUT_MS, redis, staging())).toMatchObject({ role: 'owner', writersAllowed: true });
    await resolveIdentity(redis, production(), NOW);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(deploymentIdentityStatus()).toMatchObject({ role: 'not-owner', owner: 'production', writersAllowed: false, stoppable: true });
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(sentry.captureMessage).toHaveBeenCalledWith(expect.stringMatching(/⛔|OFF in this process/), 'error');
    // Still off at the next check; the listeners run once per transition.
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(stopped).toHaveBeenCalledTimes(1);
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

describe('DEPLOYMENT_CLAIM', () => {
  it.each([[undefined, null], ['', null], ['unclaimed', 'unclaimed'], [' production ', 'production']])('%j reads as %j', (raw, expected) => {
    expect(parseDeploymentClaim(raw)).toBe(expected);
  });

  it.each(['true', 'TRUE', 'false', 'yes', '1', 'Staging'])('%j fails at load: it must name what it takes over', (raw) => {
    expect(() => parseDeploymentClaim(raw)).toThrow(/must name the deployment/);
  });
});
