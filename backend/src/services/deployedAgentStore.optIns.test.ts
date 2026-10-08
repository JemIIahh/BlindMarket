import { describe, it, expect, vi } from 'vitest';

/**
 * The delegation opt-in (migration 41 / SQLite 21) and the deploying Privy
 * user (42 / 22) round-trip through the agent store. Delegation reads back
 * off for an agent saved without it, which is every agent deployed so far.
 * Runs on the real SQLite migrations in memory; the Postgres upsert's
 * placeholders are checked against its values.
 */

const pg = vi.hoisted(() => ({ calls: [] as Array<{ sql: string; params: unknown[] }>, on: false }));
vi.mock('../config.js', () => ({ config: { get databaseUrl() { return pg.on ? 'postgres://test' : ''; } } }));
vi.mock('./neonDb.js', () => ({
  getPool: async () => ({
    query: async (sql: string, params: unknown[] = []) => {
      pg.calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  }),
}));
vi.mock('better-sqlite3', async (importOriginal) => {
  const Real = (await importOriginal<{ default: new (path: string) => object }>()).default;
  return { default: class extends Real { constructor() { super(':memory:'); } } };
});

import { saveAgent, loadAgent } from './deployedAgentStore.js';
import { stripAgentSecrets } from './agentOwnership.js';
import type { DeployedAgent } from '../types.js';

const agent = (id: string, extra: Partial<DeployedAgent> = {}): DeployedAgent => ({
  id, ownerAddress: '0xowner', name: id, instructions: 'x', provider: 'openai', model: 'm', apiKey: '', encryptedApiKey: '',
  capabilities: [], tools: [], status: 'stopped', deployedAt: '2026-10-02T00:00:00.000Z',
  walletAddress: `0x${id.padStart(40, '0')}`, publicKey: '04ab', encryptedPrivateKey: '', ...extra,
});

describe('deployed agent opt-ins and owner identity (SQLite)', () => {
  it('reads delegation back as off for an agent saved without it', async () => {
    await saveAgent(agent('a1'));
    expect((await loadAgent('a1'))?.delegationEnabled).toBe(false);
  });

  it('keeps delegation on once the owner turned it on, and off again', async () => {
    await saveAgent(agent('a2', { delegationEnabled: true }));
    expect((await loadAgent('a2'))?.delegationEnabled).toBe(true);
    await saveAgent({ ...(await loadAgent('a2'))!, delegationEnabled: false });
    expect((await loadAgent('a2'))?.delegationEnabled).toBe(false);
  });

  it('reads open submission back as off for an agent saved without it, and keeps the owner\'s choice', async () => {
    expect((await loadAgent('a1'))?.openSubmissionEnabled).toBe(false);
    await saveAgent(agent('a4', { openSubmissionEnabled: true }));
    expect((await loadAgent('a4'))?.openSubmissionEnabled).toBe(true);
    await saveAgent({ ...(await loadAgent('a4'))!, openSubmissionEnabled: false });
    expect((await loadAgent('a4'))?.openSubmissionEnabled).toBe(false);
  });

  it('keeps the deploying Privy user across later saves', async () => {
    await saveAgent(agent('a3', { privyUserId: 'did:privy:cm0abc123' }));
    const loaded = (await loadAgent('a3'))!;
    expect(loaded.privyUserId).toBe('did:privy:cm0abc123');
    await saveAgent({ ...loaded, status: 'running' });
    expect((await loadAgent('a3'))?.privyUserId).toBe('did:privy:cm0abc123');
    expect((await loadAgent('a1'))?.privyUserId).toBeUndefined();
  });

  it('never shows the Privy user in an agent\'s public form', async () => {
    const shown = stripAgentSecrets((await loadAgent('a3'))!)!;
    expect(shown).not.toHaveProperty('privyUserId');
  });
});

describe('deployed agent upsert (Postgres)', () => {
  it('binds every placeholder, delegation and the Privy user included', async () => {
    pg.on = true;
    try {
      await saveAgent(agent('p1', { delegationEnabled: true, privyUserId: 'did:privy:cm0abc123', openSubmissionEnabled: true }));
    } finally {
      pg.on = false;
    }
    const { sql, params } = pg.calls.at(-1)!;
    const highest = Math.max(...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    expect(params).toHaveLength(highest);
    expect(params.slice(-3)).toEqual([true, 'did:privy:cm0abc123', true]);
    expect(sql).toMatch(/delegation_enabled = EXCLUDED\.delegation_enabled/);
    expect(sql).toMatch(/open_submission_enabled = EXCLUDED\.open_submission_enabled/);
    // Set once: a later save never clears or replaces it.
    expect(sql).toMatch(/privy_user_id = COALESCE\(deployed_agents\.privy_user_id, EXCLUDED\.privy_user_id\)/);
  });
});
