import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A factory deploy credit pays for one agent, however often its event is
 * delivered (security audit run 1, C29). Redis is an in-memory fake; the
 * spent-payment record runs on an in-memory SQLite built from the real
 * migration.
 */

const FACTORY = '0x1E9Abb2F2e66b8Af35BED730500A94760E133a3B';
const USER = '0x2222222222222222222222222222222222222222';

const kv = vi.hoisted(() => ({ values: new Map<string, string>(), sets: new Map<string, Set<string>>() }));
vi.mock('./redis.js', () => ({
  redis: {
    get: vi.fn(async (k: string) => kv.values.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { kv.values.set(k, v); return 'OK'; }),
    del: vi.fn(async (k: string) => (kv.values.delete(k) ? 1 : 0)),
    exists: vi.fn(async (k: string) => (kv.values.has(k) ? 1 : 0)),
    sadd: vi.fn(async (k: string, v: string) => { kv.sets.set(k, (kv.sets.get(k) ?? new Set()).add(v)); return 1; }),
    srem: vi.fn(async (k: string, v: string) => (kv.sets.get(k)?.delete(v) ? 1 : 0)),
    smembers: vi.fn(async (k: string) => [...(kv.sets.get(k) ?? [])]),
  },
}));
vi.mock('../config.js', () => ({ config: { databaseUrl: '', arcAgentFactoryAddress: FACTORY } }));
vi.mock('./chain.js', () => ({ arcProvider: {} }));
vi.mock('./deploymentIdentity.js', () => ({ backgroundWritesAllowed: () => true }));
const mem = vi.hoisted(() => ({ db: null as any }));
vi.mock('./database.js', async () => {
  const Database = (await import('better-sqlite3')).default;
  const actual = await vi.importActual<typeof import('./database.js')>('./database.js');
  mem.db = new Database(':memory:');
  mem.db.exec(actual.sqliteMigrationSql(20)!);
  return { ...actual, getDb: () => mem.db };
});

const { recordCredit, claimDeployCredit, markDeployCreditUsed, restoreDeployCredit, listDeployCredits } =
  await import('./agentFactoryListener.js');

const event = (nonce: bigint) => ({
  args: { user: USER, nonce, usdcAmount: 1_000_000n, timestamp: 1n },
  blockNumber: 100,
  transactionHash: '0x' + 'ee'.repeat(32),
}) as any;

beforeEach(() => {
  kv.values.clear();
  kv.sets.clear();
  mem.db.exec('DELETE FROM spent_deploy_payments');
});

describe('factory deploy credits (audit run 1, C29)', () => {
  it('a re-delivered event does not bring back a credit that paid for an agent', async () => {
    await recordCredit(event(5n));
    const credit = await claimDeployCredit(USER);
    expect(credit?.nonce).toBe('5');
    await markDeployCreditUsed(credit!, 'agent-1');

    await recordCredit(event(5n)); // retried chunk / overlapping tick / rescan
    expect(await listDeployCredits(USER)).toEqual([]);
    expect(await claimDeployCredit(USER)).toBeNull();
  });

  it('drops a credit Redis still holds when its payment was already spent', async () => {
    await recordCredit(event(6n));
    const credit = await claimDeployCredit(USER);
    await markDeployCreditUsed(credit!, 'agent-1');
    // An older Redis snapshot restored after the spend.
    kv.values.set(`agentfactory:credit:${USER.toLowerCase()}:6`, JSON.stringify(credit));
    kv.sets.set(`agentfactory:credits:${USER.toLowerCase()}`, new Set(['6']));
    expect(await claimDeployCredit(USER)).toBeNull();
  });

  it('gives a credit back after a failed deploy, and it can pay for the retry', async () => {
    await recordCredit(event(7n));
    const credit = await claimDeployCredit(USER);
    await restoreDeployCredit(credit!);
    const again = await claimDeployCredit(USER);
    expect(again?.nonce).toBe('7');
  });

  it('pays for one agent per event, never more', async () => {
    await recordCredit(event(8n));
    expect(await claimDeployCredit(USER)).not.toBeNull();
    expect(await claimDeployCredit(USER)).toBeNull();
  });
});
