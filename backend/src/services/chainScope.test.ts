import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A chain key names a chain, not a network, and the backend's per-chain state
 * describes one escrow on one network. Moving Arc from testnet (5042002) to
 * mainnet (5042) under the same 'arc' key would have read the testnet index,
 * checkpoints, dispute markers and deploy credits as mainnet state, and escrow
 * ids restart at 1 on every escrow. State now lives under chainScope(chain):
 * the bare key on each chain's first network, the chain id on any other.
 */

// The network the backend runs each chain on, switchable per test.
const net = vi.hoisted(() => ({ arc: 5042002, base: 84532 }));
vi.mock('./settlementChains.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./settlementChains.js')>();
  return {
    ...mod,
    settlementChainConfig: (key: 'arc' | 'base') => ({ ...mod.settlementChainConfig(key), chainId: net[key] }),
  };
});

const redisStub = vi.hoisted(() => ({
  open: [] as string[],
  values: new Map<string, string>(),
}));
vi.mock('./redis.js', () => ({
  redis: {
    get: vi.fn(async (k: string) => redisStub.values.get(k) ?? null),
    set: vi.fn(async () => 'OK'),
    smembers: vi.fn(async () => redisStub.open),
    pipeline: vi.fn(() => {
      const keys: string[] = [];
      const pipe = {
        get: (k: string) => { keys.push(k); return pipe; },
        exec: async () => keys.map((k) => [null, redisStub.values.get(k) ?? null]),
      };
      return pipe;
    }),
  },
}));
vi.mock('./database.js', () => ({ getDb: vi.fn() }));
vi.mock('./neonDb.js', () => ({ getPool: vi.fn() }));

const { CHAIN_NETWORK_IDS, FIRST_NETWORK_CHAIN_ID, chainScope, onCurrentNetwork, otherNetworkIds } = await import('./chainScope.js');
const { isSettlementChainKey } = await import('./settlementChains.js');
const { TIER_CHAIN_IDS } = await import('./settlementTier.js');
const { disputeKeys } = await import('./disputeKeys.js');
const { fingerprintKey } = await import('./escrowFingerprint.js');
const { factoryPaymentKey, transferPaymentKey } = await import('./spentDeployPayments.js');
const { browseAgentTasks } = await import('./a2aStore.js');

beforeEach(() => {
  net.arc = 5042002;
  net.base = 84532;
  redisStub.open = [];
  redisStub.values.clear();
});

describe('chainScope', () => {
  it("keeps the bare key on each chain's first network, so existing state stays where it is", () => {
    expect(chainScope('arc')).toBe('arc');
    expect(chainScope('base')).toBe('base');
  });

  it('puts the chain id in the key on any other network', () => {
    net.arc = 5042;
    expect(chainScope('arc')).toBe('arc@5042');
    expect(chainScope('base', 8453)).toBe('base@8453');
  });

  it('knows every network a settlement chain has a tier for, its first network among them', () => {
    for (const [chain, ids] of Object.entries(TIER_CHAIN_IDS)) {
      if (!isSettlementChainKey(chain)) continue;
      expect(CHAIN_NETWORK_IDS[chain]).toEqual(expect.arrayContaining([ids.mainnet, ids.testnet]));
    }
    for (const [chain, ids] of Object.entries(CHAIN_NETWORK_IDS)) {
      expect(ids).toContain(FIRST_NETWORK_CHAIN_ID[chain as keyof typeof FIRST_NETWORK_CHAIN_ID]);
    }
  });

  it("names a chain's networks other than the one this backend runs it on", () => {
    expect(otherNetworkIds('arc')).toEqual([5042]);
    expect(otherNetworkIds('base')).toEqual([8453]);
    net.arc = 5042;
    expect(otherNetworkIds('arc')).toEqual([5042002]);
    // A network no tier lists (a local devnet): every known one is another's.
    net.arc = 31337;
    expect(otherNetworkIds('arc')).toEqual([5042002, 5042]);
  });

  it('scopes every per-chain store by the network', () => {
    expect(disputeKeys('arc').done('7')).toBe('arc:dispute-done:7');
    expect(fingerprintKey('arc')).toBe('arc:events:escrow');
    expect(factoryPaymentKey('0xFACTORY', '3')).toBe('arc:factory:0xfactory:3');

    net.arc = 5042;
    expect(disputeKeys('arc').done('7')).toBe('arc@5042:dispute-done:7');
    expect(disputeKeys('arc').parked).toBe('arc@5042:dispute-parked');
    expect(fingerprintKey('arc')).toBe('arc@5042:events:escrow');
    expect(factoryPaymentKey('0xFACTORY', '3')).toBe('arc@5042:factory:0xfactory:3');
    expect(transferPaymentKey('0xABC')).toBe('arc@5042:transfer:0xabc');
    // Base did not move.
    expect(disputeKeys('base').done('7')).toBe('base:dispute-done:7');
  });
});

describe('onCurrentNetwork', () => {
  it('takes a task listed before chainId existed as listed on the first network', () => {
    expect(onCurrentNetwork({ chain: 'arc' })).toBe(true);
    net.arc = 5042;
    expect(onCurrentNetwork({ chain: 'arc' })).toBe(false);
  });

  it('compares a recorded chainId with the network the chain runs on', () => {
    net.arc = 5042;
    expect(onCurrentNetwork({ chain: 'arc', chainId: 5042 })).toBe(true);
    expect(onCurrentNetwork({ chain: 'arc', chainId: 5042002 })).toBe(false);
    expect(onCurrentNetwork({ chain: 'base', chainId: 84532 })).toBe(true);
  });

  it('leaves rows with no recorded settlement chain as they were', () => {
    net.arc = 5042;
    expect(onCurrentNetwork(null)).toBe(true);
    expect(onCurrentNetwork({})).toBe(true);
    expect(onCurrentNetwork({ chain: '0g' })).toBe(true);
  });
});

describe('the open feed', () => {
  const task = (id: string, extra: Record<string, unknown>) => {
    redisStub.open.push(id);
    redisStub.values.set(`a2a:meta:${id}`, JSON.stringify({ taskId: id, targetExecutorType: 'agent', requiredCapabilities: [], chain: 'arc', ...extra }));
    redisStub.values.set(`a2a:state:${id}`, JSON.stringify({ taskId: id, status: 'open' }));
  };

  it('leaves out tasks listed on a network the chain has moved off', async () => {
    net.arc = 5042;
    task('0xold', {});                    // listed on Arc testnet before chainId existed
    task('0xoldtagged', { chainId: 5042002 });
    task('0xnew', { chainId: 5042 });
    task('0xbase', { chain: 'base' });
    expect((await browseAgentTasks()).map((t) => t.meta.taskId).sort()).toEqual(['0xbase', '0xnew']);
  });

  it('lists them while the chain still runs on that network', async () => {
    task('0xold', {});
    task('0xoldtagged', { chainId: 5042002 });
    expect((await browseAgentTasks()).map((t) => t.meta.taskId).sort()).toEqual(['0xold', '0xoldtagged']);
  });
});
