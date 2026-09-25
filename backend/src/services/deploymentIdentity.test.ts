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
      // Like ioredis: an explicit undefined mode goes to Redis as an extra
      // argument, and a plain SET answers "ERR syntax error".
      set: vi.fn(async (k: string, v: string, ...rest: Array<string | undefined>) => {
        if (rest.length > 0 && rest[0] === undefined) throw new Error('ERR syntax error');
        if (rest[0] === 'NX' && store.has(k)) return null;
        store.set(k, v);
        return 'OK' as const;
      }),
    },
  };
});
vi.mock('./redis.js', () => ({ redis }));
const sentry = vi.hoisted(() => ({ captureMessage: vi.fn() }));
vi.mock('@sentry/node', () => sentry);

// The network this process runs each chain on, which picks its index keys
// (chainScope): Arc testnet and Base Sepolia unless a test moves one.
const net = vi.hoisted(() => ({ arc: 5042002, base: 84532 }));
vi.mock('./settlementChains.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./settlementChains.js')>();
  return { ...mod, settlementChainConfig: (key: 'arc' | 'base') => ({ ...mod.settlementChainConfig(key), chainId: net[key] }) };
});

import {
  resolveIdentity, checkDeploymentIdentity, deploymentIdentityStatus, backgroundWritesAllowed, onBackgroundWritesStopped, onBackgroundWritesResumed,
  _resetIdentityForTests, IDENTITY_KEY, CHECK_TIMEOUT_MS, RETRY_MS, type DeploymentFacts, type Self,
} from './deploymentIdentity.js';
import { parseDeploymentId } from '../config.js';

const PROD: DeploymentFacts = {
  tier: null,
  chains: {
    'arc': { chainId: 16661, escrow: '0x3d0374963daad43e31d42373eb11156a8e8ce2ff' },
    base: { chainId: 84532, escrow: '0xcca5ab873158b888158ad9dc36fb4ee683efbebf' },
  },
};
const STAGING: DeploymentFacts = {
  tier: 'testnet',
  chains: {
    'arc': { chainId: 16602, escrow: '0x0a0a000000000000000000000000000000000002' },
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
  store.set('arc:events:checkpoint', '33500000');
  store.set('base:events:checkpoint', '46300000');
  if (fingerprints) {
    store.set('arc:events:escrow', `16661:${PROD.chains['arc'].escrow}`);
    store.set('base:events:escrow', `84532:${PROD.chains.base.escrow}`);
  }
}

/** An older staging stack's claim, for takeover tests. */
const localDevStackClaim = () => staging({ deploymentId: 'old-staging' });

/** What a staging process on production's Redis could write (the review's B1). */
function plantStagingFingerprints() {
  store.set('arc:events:escrow', `16602:${STAGING.chains['arc'].escrow}`);
  store.set('base:events:escrow', `84532:${STAGING.chains.base.escrow}`);
}

// Chains on real networks, for the tests where the network a process runs a
// chain on (net, which picks its keys) must agree with its facts.
const ARC_TESTNET = { chainId: 5042002, escrow: '0xabf70843e0380f1e749d2b85c30dd6820ff5c731' };
const ARC_MAINNET = { chainId: 5042, escrow: '0xa4c0000000000000000000000000000000005042' };
const BASE_SEPOLIA = { chainId: 84532, escrow: '0xcca5ab873158b888158ad9dc36fb4ee683efbebf' };
/** A process on Arc mainnet whose Base Sepolia escrow is not production's. */
const ON_ARC_MAINNET: DeploymentFacts = {
  tier: null,
  chains: { arc: ARC_MAINNET, base: { chainId: 84532, escrow: '0xa1f75b5ec92f4485d4eefa339dc2b8af25df0ec5' } },
};

/** Production's index on Arc testnet and Base Sepolia: the bare 'arc:' and 'base:' keys. */
function arcTestnetHistory() {
  store.set('arc:events:escrow', `5042002:${ARC_TESTNET.escrow}`);
  store.set('arc:events:checkpoint', '63970000');
  store.set('base:events:escrow', `84532:${BASE_SEPOLIA.escrow}`);
  store.set('base:events:checkpoint', '47295000');
}

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  _resetIdentityForTests();
  net.arc = 5042002;
  net.base = 84532;
});

describe('production (never stopped)', () => {
  it('claims an empty Redis', async () => {
    const s = await resolveIdentity(redis, production(), NOW);
    expect(s).toEqual({ deploymentId: 'production', role: 'owner', owner: 'production', writersAllowed: true, stoppable: false, reason: null });
    expect(record()).toEqual({ id: 'production', ...PROD, stoppable: false, claimedAt: NOW().toISOString(), updatedAt: NOW().toISOString() });
  });

  it('claims its Redis even with fingerprints another process planted there, and says so', async () => {
    productionHistory({ fingerprints: false });
    plantStagingFingerprints();
    const s = await resolveIdentity(redis, production(), NOW);
    expect(s).toMatchObject({ role: 'owner', writersAllowed: true });
    expect(s.reason).toMatch(/arc:events:escrow=16602/);
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
    expect(record()).toEqual({ id: 'production', ...PROD, stoppable: false, claimedAt: LATER().toISOString(), updatedAt: LATER().toISOString() });
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
    expect(s.reason).toMatch(/arc:events:escrow=16661/);
    expect(s.reason).toMatch(/base:events:escrow=84532:0xcca5/);
    expect(s.reason).toMatch(/DEPLOYMENT_CLAIM=unclaimed/);
    expect(store.has(IDENTITY_KEY)).toBe(false);
  });

  it("does not claim production's pre-fingerprint history, and does not suggest claiming it", async () => {
    productionHistory({ fingerprints: false });
    const s = await resolveIdentity(redis, staging(), NOW);
    expect(s).toMatchObject({ role: 'not-owner', writersAllowed: false });
    expect(s.reason).toMatch(/looks like production's Redis from before identity checks \(base:events:checkpoint with no base:events:escrow/);
    expect(s.reason).toMatch(/do not claim it/);
    expect(s.reason).not.toMatch(/DEPLOYMENT_CLAIM=/);
  });

  it('counts a fingerprint on a chain it does not settle on', async () => {
    store.set('base:events:escrow', `84532:${PROD.chains.base.escrow}`);
    const s = await resolveIdentity(redis, staging({ facts: { tier: 'testnet', chains: { 'arc': STAGING.chains['arc'] } } }), NOW);
    expect(s.writersAllowed).toBe(false);
    expect(s.reason).toMatch(/no base escrow/);
  });

  it('claims a Redis whose fingerprints are its own', async () => {
    plantStagingFingerprints();
    expect(await resolveIdentity(redis, staging(), NOW)).toMatchObject({ role: 'owner', writersAllowed: true });
  });

  it("may not run under production's DEPLOYMENT_ID with anything but production's escrows (the review's P2)", async () => {
    await resolveIdentity(redis, production(), NOW);
    const before = store.get(IDENTITY_KEY);
    const others: DeploymentFacts[] = [
      // A Base-only staging stack sharing production's Base escrow.
      { tier: null, chains: { base: PROD.chains.base } },
      // Production's chains, with its own Base escrow.
      { tier: null, chains: { ...PROD.chains, base: STAGING.chains.base } },
      // Production's escrows plus one more chain.
      { tier: null, chains: { ...PROD.chains, arc: { chainId: 5042002, escrow: '0xa4c0000000000000000000000000000000000001' } } },
    ];
    for (const facts of others) {
      const s = await resolveIdentity(redis, staging({ deploymentId: 'production', facts }), NOW, { first: false });
      expect(s).toMatchObject({ role: 'not-owner', owner: 'production', writersAllowed: false });
      expect(s.reason).toMatch(/is production.*may not run under its DEPLOYMENT_ID/);
    }
    expect(store.get(IDENTITY_KEY)).toBe(before);
  });

  it("keeps production writing when its environment drifts (NODE_ENV lost): same id, same escrows (the review's P1)", async () => {
    await resolveIdentity(redis, production(), NOW);
    const before = store.get(IDENTITY_KEY);
    const s = await resolveIdentity(redis, production({ stoppable: true }), LATER, { first: false });
    expect(s).toMatchObject({ role: 'owner', owner: 'production', writersAllowed: true, stoppable: true });
    expect(s.reason).toMatch(/not configured as production.*fix its environment/);
    // The record stays production's: it must not start saying stoppable.
    expect(store.get(IDENTITY_KEY)).toBe(before);
  });

  it('stops when its id comes with other chain ids: another network under the same name', async () => {
    await resolveIdentity(redis, staging(), NOW);
    const moved: DeploymentFacts = { ...STAGING, chains: { ...STAGING.chains, 'arc': { chainId: 16661, escrow: STAGING.chains['arc'].escrow } } };
    const s = await resolveIdentity(redis, staging({ facts: moved }), NOW);
    expect(s).toMatchObject({ role: 'not-owner', owner: 'staging-testnet', writersAllowed: false });
    expect(s.reason).toMatch(/arc 16602→16661/);
    expect(record().chains['arc'].chainId).toBe(16602);
  });

  it('records a redeployed escrow and a tier change', async () => {
    await resolveIdentity(redis, staging(), NOW);
    const grown: DeploymentFacts = { tier: 'mainnet', chains: { ...STAGING.chains, base: { chainId: 84532, escrow: '0x' + 'b9'.repeat(20) } } };
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
      expect(record()).toEqual({ id: 'staging-testnet', ...STAGING, stoppable: true, claimedAt: LATER().toISOString(), updatedAt: LATER().toISOString() });
    });

    it('cannot take a different Redis: a value left in the environment is ignored there', async () => {
      // (Here the other Redis is production's; another staging stack's is covered below.)
      await resolveIdentity(redis, production(), NOW);
      const s = await resolveIdentity(redis, staging({ claim: 'old-staging' }), LATER);
      expect(s).toMatchObject({ role: 'not-owner', owner: 'production', writersAllowed: false });
      expect(s.reason).toMatch(/DEPLOYMENT_CLAIM=old-staging ignored/);
      expect(record().id).toBe('production');
    });

    it('"unclaimed" takes a Redis with no record despite its index keys, and nothing else', async () => {
      plantStagingFingerprints();
      store.set('arc:events:escrow', '16602:0x' + '0c'.repeat(20)); // an escrow this stack redeployed
      expect(await resolveIdentity(redis, staging({ claim: 'unclaimed' }), NOW)).toMatchObject({ role: 'owner', writersAllowed: true });
      store.clear();
      await resolveIdentity(redis, production(), NOW);
      expect(await resolveIdentity(redis, staging({ claim: 'unclaimed' }), NOW)).toMatchObject({ role: 'not-owner', writersAllowed: false });
    });

    it('"unclaimed" does not take production\'s Redis from before identity checks', async () => {
      productionHistory({ fingerprints: false });
      const s = await resolveIdentity(redis, staging({ claim: 'unclaimed' }), NOW);
      expect(s).toMatchObject({ role: 'not-owner', writersAllowed: false });
      expect(s.reason).toMatch(/DEPLOYMENT_CLAIM=unclaimed ignored: this looks like production's Redis/);
      expect(store.has(IDENTITY_KEY)).toBe(false);
    });

    it('never takes production\'s Redis, even when it names production', async () => {
      await resolveIdentity(redis, production(), NOW);
      const s = await resolveIdentity(redis, staging({ claim: 'production' }), NOW);
      expect(s).toMatchObject({ role: 'not-owner', owner: 'production', writersAllowed: false });
      expect(s.reason).toMatch(/"production" is production, whose Redis is never taken over/);
      expect(record().id).toBe('production');
    });

    it('a leftover value naming an owner this Redis does not have is ignored', async () => {
      await resolveIdentity(redis, staging({ deploymentId: 'another-staging' }), NOW);
      const s = await resolveIdentity(redis, staging({ claim: 'old-staging' }), NOW);
      expect(s).toMatchObject({ role: 'not-owner', owner: 'another-staging', writersAllowed: false });
      expect(s.reason).toMatch(/DEPLOYMENT_CLAIM=old-staging ignored: this Redis is "another-staging"'s, not what it names/);
    });

    it('counts on the first check only', async () => {
      await resolveIdentity(redis, localDevStackClaim(), NOW);
      const later = await resolveIdentity(redis, staging({ claim: 'old-staging' }), LATER, { first: false });
      expect(later).toMatchObject({ role: 'not-owner', owner: 'old-staging', writersAllowed: false });
      expect(record().id).toBe('old-staging');
    });

    it.each(['true', 'TRUE', 'yes', '1', 'Staging'])('ignores %j, which names nothing, and says so', async (claim) => {
      await resolveIdentity(redis, localDevStackClaim(), NOW);
      const s = await resolveIdentity(redis, staging({ claim }), NOW);
      expect(s).toMatchObject({ role: 'not-owner', writersAllowed: false });
      expect(s.reason).toMatch(new RegExp(`DEPLOYMENT_CLAIM=${claim} ignored: it must name the owner`));
      expect(record().id).toBe('old-staging');
    });

    it('takes back its own record after its chains moved', async () => {
      await resolveIdentity(redis, staging(), NOW);
      const moved: DeploymentFacts = { ...STAGING, chains: { ...STAGING.chains, 'arc': { chainId: 16661, escrow: STAGING.chains['arc'].escrow } } };
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

  // Its facts and the network it runs Arc on agree: it reads Arc mainnet's
  // keys (arc@5042:), so production's Arc testnet index is another network's.
  it("stops on another network's fingerprint, and names the keys to delete if the Redis is its own", async () => {
    arcTestnetHistory();
    net.arc = 5042;
    const s = await resolveIdentity(redis, localDev({ facts: ON_ARC_MAINNET }), NOW);
    expect(s).toMatchObject({ role: 'not-owner', writersAllowed: false });
    expect(s.reason).toMatch(/arc:events:escrow=5042002:0xabf7.* \(this process: 5042:0xa4c0/);
    expect(s.reason).toMatch(/delete base:events:escrow, arc:events:escrow and restart/);
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
    expect(s.reason).toMatch(/arc 16661, base 84532/);
  });

  it("stops on production's record when only its escrow differs, on a chain they share", async () => {
    await resolveIdentity(redis, production(), NOW);
    const baseOnly: DeploymentFacts = { tier: null, chains: { base: { chainId: 84532, escrow: '0xa1f75b5ec92f4485d4eefa339dc2b8af25df0ec5' } } };
    expect(await resolveIdentity(redis, localDev({ facts: baseOnly }), NOW)).toMatchObject({ role: 'not-owner', owner: 'production', writersAllowed: false });
  });

  it("runs on a record whose chains are its own (a local stack's own claim)", async () => {
    await resolveIdentity(redis, staging(), NOW);
    expect(await resolveIdentity(redis, localDev(), NOW)).toMatchObject({ role: 'unset', owner: 'staging-testnet', writersAllowed: true });
  });
});

/**
 * Index keys are per network (chainScope): 'arc:' on Arc testnet, 'arc@5042:'
 * on Arc mainnet. A process reads its own network's keys, so it would never
 * see another network's index there. A stoppable process reads the other
 * networks' keys too: nothing it wrote is under them. Production does not:
 * once it moves a chain, the old network's keys are its own history.
 */
describe('another network of a chain', () => {
  it("stops a process on Arc testnet on Arc mainnet's index (arc@5042:)", async () => {
    store.set('arc@5042:events:escrow', `5042:${ARC_MAINNET.escrow}`);
    store.set('arc@5042:events:checkpoint', '1200000');
    store.set('base:events:escrow', `84532:${BASE_SEPOLIA.escrow}`);
    const own: DeploymentFacts = { tier: null, chains: { arc: ARC_TESTNET, base: BASE_SEPOLIA } };
    const s = await resolveIdentity(redis, localDev({ facts: own }), NOW);
    expect(s).toMatchObject({ role: 'not-owner', writersAllowed: false });
    expect(s.reason).toMatch(/arc@5042:events:escrow=5042:0xa4c0/);
  });

  it("counts another network's checkpoint with no fingerprint, which on its own network is only noted", async () => {
    store.set('arc:events:checkpoint', '63970000');
    expect(await resolveIdentity(redis, localDev({ facts: { tier: null, chains: { arc: ARC_TESTNET } } }), NOW))
      .toMatchObject({ role: 'unset', writersAllowed: true });
    net.arc = 5042;
    const s = await resolveIdentity(redis, localDev({ facts: { tier: null, chains: { arc: ARC_MAINNET } } }), NOW);
    expect(s).toMatchObject({ role: 'not-owner', writersAllowed: false });
    expect(s.reason).toMatch(/arc:events:checkpoint with no arc:events:escrow/);
  });

  it('does not claim a Redis with another network\'s index for a staging stack', async () => {
    arcTestnetHistory();
    net.arc = 5042;
    // Production's Base escrow too: only the Arc testnet keys are not its own.
    const facts: DeploymentFacts = { tier: null, chains: { arc: ARC_MAINNET, base: BASE_SEPOLIA } };
    const s = await resolveIdentity(redis, staging({ facts }), NOW);
    expect(s).toMatchObject({ role: 'not-owner', owner: null, writersAllowed: false });
    expect(s.reason).toMatch(/holds another deployment's index \(arc:events:escrow=5042002/);
    expect(store.has(IDENTITY_KEY)).toBe(false);
  });

  it('"unclaimed" does not take another network\'s index from before identity checks', async () => {
    store.set('arc:events:checkpoint', '63970000');
    net.arc = 5042;
    const s = await resolveIdentity(redis, staging({ facts: ON_ARC_MAINNET, claim: 'unclaimed' }), NOW);
    expect(s).toMatchObject({ role: 'not-owner', writersAllowed: false });
    expect(s.reason).toMatch(/DEPLOYMENT_CLAIM=unclaimed ignored: this looks like production's Redis/);
    expect(store.has(IDENTITY_KEY)).toBe(false);
  });

  it('leaves production on Arc mainnet alone with its own Arc testnet history, and reads none of it', async () => {
    arcTestnetHistory();
    store.set('arc@5042:events:escrow', `5042:${ARC_MAINNET.escrow}`);
    net.arc = 5042;
    const facts: DeploymentFacts = { tier: null, chains: { arc: ARC_MAINNET, base: BASE_SEPOLIA } };
    expect(await resolveIdentity(redis, production({ deploymentId: null, facts }), NOW))
      .toEqual({ deploymentId: null, role: 'unset', owner: null, writersAllowed: true, stoppable: false, reason: null });
    expect(await resolveIdentity(redis, production({ facts }), NOW))
      .toEqual({ deploymentId: 'production', role: 'owner', owner: 'production', writersAllowed: true, stoppable: false, reason: null });
    expect(redis.get).not.toHaveBeenCalledWith('arc:events:escrow');
    expect(redis.get).not.toHaveBeenCalledWith('arc:events:checkpoint');
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
    expect(s).toMatchObject({ role: 'unknown', writersAllowed: false });
    expect(s.reason).toMatch(/cannot read/);
    expect(store.get(IDENTITY_KEY)).toBe(raw);
    // Production keeps writing.
    expect(await resolveIdentity(redis, production(), NOW)).toMatchObject({ role: 'unknown', writersAllowed: true });
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

  it('gives up after CHECK_TIMEOUT_MS: production writes, a stoppable process waits (the review\'s B3)', async () => {
    const dead = { get: () => new Promise<string | null>(() => {}), set: redis.set };
    vi.useFakeTimers();
    const prod = checkDeploymentIdentity(undefined, dead, production());
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS);
    expect(await prod).toMatchObject({ role: 'unknown', writersAllowed: true });
    _resetIdentityForTests();
    const stg = checkDeploymentIdentity(undefined, dead, staging());
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS);
    expect(await stg).toMatchObject({ role: 'unknown', writersAllowed: false });
    expect(deploymentIdentityStatus()?.reason).toMatch(/no answer from Redis in 10s.*writes stay off until a check answers/);
    expect(backgroundWritesAllowed('0G indexer')).toBe(false);
  });

  it('a check that timed out writes nothing when Redis answers late', async () => {
    vi.useFakeTimers();
    const late = { get: (k: string) => new Promise<string | null>((r) => setTimeout(() => r(store.get(k) ?? null), CHECK_TIMEOUT_MS + 5_000)), set: redis.set };
    const check = checkDeploymentIdentity(undefined, late, staging());
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS);
    expect(await check).toMatchObject({ role: 'unknown' });
    // The abandoned attempt makes nine slow reads (the record, then each
    // chain's fingerprint and checkpoint on both its networks), then tries to claim.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(late.get).toBeDefined();
    expect(store.has(IDENTITY_KEY)).toBe(false);
  });

  it('keeps DEPLOYMENT_CLAIM for the first check that answers, not the first that tried', async () => {
    await resolveIdentity(redis, localDevStackClaim(), NOW);
    vi.useFakeTimers();
    let up = false;
    const flaky = { get: (k: string) => (up ? Promise.resolve(store.get(k) ?? null) : new Promise<string | null>(() => {})), set: redis.set };
    const first = checkDeploymentIdentity(undefined, flaky, staging({ claim: 'old-staging' }));
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS);
    expect(await first).toMatchObject({ role: 'unknown' });
    up = true;
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(deploymentIdentityStatus()).toMatchObject({ role: 'owner', owner: 'staging-testnet', writersAllowed: true });
  });

  it('stops honouring DEPLOYMENT_CLAIM once a check has answered', async () => {
    vi.useFakeTimers();
    await resolveIdentity(redis, staging({ deploymentId: 'another-staging' }), NOW);
    // First check answers: the claim names an owner this Redis does not have.
    expect(await checkDeploymentIdentity(CHECK_TIMEOUT_MS, redis, staging({ claim: 'old-staging' }))).toMatchObject({ role: 'not-owner' });
    // Later the Redis comes to be old-staging's: the claim must not take it now.
    await resolveIdentity(redis, localDevStackClaim(), NOW, { first: true });
    store.set(IDENTITY_KEY, JSON.stringify({ ...record(), id: 'old-staging' }));
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(deploymentIdentityStatus()).toMatchObject({ role: 'not-owner', owner: 'old-staging', writersAllowed: false });
    expect(record().id).toBe('old-staging');
  });

  it('retries until Redis answers, and the answer takes effect', async () => {
    vi.useFakeTimers();
    let up = false;
    const flaky = {
      get: (k: string) => (up ? Promise.resolve(store.get(k) ?? null) : new Promise<string | null>(() => {})),
      set: redis.set,
    };
    const first = checkDeploymentIdentity(undefined, flaky, staging());
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS);
    expect(await first).toMatchObject({ role: 'unknown', writersAllowed: false });

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

  describe('through the real check (its guarded store passes Redis exactly what a plain SET takes)', () => {
    it('production takes its Redis back', async () => {
      await resolveIdentity(redis, staging(), NOW);
      expect(await checkDeploymentIdentity(CHECK_TIMEOUT_MS, redis, production())).toMatchObject({ role: 'owner', owner: 'production', writersAllowed: true });
      expect(record().id).toBe('production');
    });

    it('an owner records its moved chains (production) and its redeployed escrow (staging)', async () => {
      await resolveIdentity(redis, production(), NOW);
      const mainnet: DeploymentFacts = { tier: 'mainnet', chains: { ...PROD.chains, base: { chainId: 8453, escrow: '0x' + '8b'.repeat(20) } } };
      expect(await checkDeploymentIdentity(CHECK_TIMEOUT_MS, redis, production({ facts: mainnet }))).toMatchObject({ role: 'owner' });
      expect(record().chains.base.chainId).toBe(8453);

      store.clear();
      _resetIdentityForTests();
      await resolveIdentity(redis, staging(), NOW);
      const redeployed: DeploymentFacts = { ...STAGING, chains: { ...STAGING.chains, base: { chainId: 84532, escrow: '0x' + 'b9'.repeat(20) } } };
      expect(await checkDeploymentIdentity(CHECK_TIMEOUT_MS, redis, staging({ facts: redeployed }))).toMatchObject({ role: 'owner', writersAllowed: true });
      expect(record().chains.base.escrow).toBe('0x' + 'b9'.repeat(20));
    });

    it('a named DEPLOYMENT_CLAIM applies', async () => {
      await resolveIdentity(redis, localDevStackClaim(), NOW);
      expect(await checkDeploymentIdentity(CHECK_TIMEOUT_MS, redis, staging({ claim: 'old-staging' }))).toMatchObject({ role: 'owner', owner: 'staging-testnet' });
      expect(record().id).toBe('staging-testnet');
    });

    it('production with a drifted environment keeps writing, and it is reported', async () => {
      await resolveIdentity(redis, production(), NOW);
      const before = store.get(IDENTITY_KEY);
      expect(await checkDeploymentIdentity(CHECK_TIMEOUT_MS, redis, production({ stoppable: true }))).toMatchObject({ role: 'owner', writersAllowed: true });
      expect(backgroundWritesAllowed('0G indexer')).toBe(true);
      expect(sentry.captureMessage).toHaveBeenCalledWith(expect.stringMatching(/not configured as production/), 'warning');
      expect(store.get(IDENTITY_KEY)).toBe(before);
    });
  });

  it('a Redis blip does not stop a stack\'s workers; the answer after it resumes writes', async () => {
    vi.useFakeTimers();
    const stopped = vi.fn();
    const resumed = vi.fn();
    onBackgroundWritesStopped(stopped);
    onBackgroundWritesResumed(resumed);
    let blip = false;
    const flaky = { get: (k: string) => (blip ? Promise.reject(new Error('Connection is closed.')) : redis.get(k)), set: redis.set };
    expect(await checkDeploymentIdentity(CHECK_TIMEOUT_MS, flaky, staging())).toMatchObject({ role: 'owner' });
    blip = true;
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(deploymentIdentityStatus()).toMatchObject({ role: 'unknown', writersAllowed: false });
    expect(stopped).not.toHaveBeenCalled();
    blip = false;
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(deploymentIdentityStatus()).toMatchObject({ role: 'owner', writersAllowed: true });
    expect(resumed).toHaveBeenCalledTimes(1);
    expect(stopped).not.toHaveBeenCalled();
  });

  it('on a Redis error, production writes and a stoppable process waits', async () => {
    const broken = { get: async () => { throw new Error('ECONNREFUSED'); }, set: redis.set };
    const prod = await checkDeploymentIdentity(CHECK_TIMEOUT_MS, broken, production());
    expect(prod).toMatchObject({ role: 'unknown', writersAllowed: true });
    expect(prod.reason).toMatch(/ECONNREFUSED/);
    _resetIdentityForTests();
    expect(await checkDeploymentIdentity(CHECK_TIMEOUT_MS, broken, staging())).toMatchObject({ role: 'unknown', writersAllowed: false });
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
