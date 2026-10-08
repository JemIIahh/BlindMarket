import { describe, it, expect, vi } from 'vitest';

/**
 * updateAgentFields / setAgentStatus write only the columns they are given
 * (delta audit 2026-10-06, deploy-2): the worker heartbeat and the owner's
 * toggles no longer rewrite the whole row from a copy that may be stale.
 * SQLite runs on the real migrations in memory; the Postgres UPDATE is checked
 * for its columns and placeholders.
 */

const pg = vi.hoisted(() => ({ calls: [] as Array<{ sql: string; params: unknown[] }>, on: false, rowCount: 1 }));
vi.mock('../config.js', () => ({ config: { get databaseUrl() { return pg.on ? 'postgres://test' : ''; } } }));
vi.mock('./neonDb.js', () => ({
  getPool: async () => ({
    query: async (sql: string, params: unknown[] = []) => {
      pg.calls.push({ sql, params });
      return { rows: [], rowCount: pg.rowCount };
    },
  }),
}));
vi.mock('better-sqlite3', async (importOriginal) => {
  const Real = (await importOriginal<{ default: new (path: string) => object }>()).default;
  return { default: class extends Real { constructor() { super(':memory:'); } } };
});

import { saveAgent, loadAgent, updateAgentFields, setAgentStatus } from './deployedAgentStore.js';
import type { DeployedAgent } from '../types.js';

const agent = (id: string, extra: Partial<DeployedAgent> = {}): DeployedAgent => ({
  id, ownerAddress: '0xowner', name: id, instructions: 'x', provider: 'openai', model: 'm', apiKey: '', encryptedApiKey: '',
  capabilities: [], tools: [], status: 'running', deployedAt: '2026-10-06T00:00:00.000Z',
  walletAddress: `0x${id.padStart(40, '0')}`, publicKey: '04ab', encryptedPrivateKey: '', ...extra,
});

async function withPg<T>(fn: () => Promise<T>): Promise<T> {
  pg.on = true;
  try { return await fn(); } finally { pg.on = false; }
}

describe('targeted agent writes (SQLite)', () => {
  it('writes only the given column and leaves the rest as they are now', async () => {
    await saveAgent(agent('f1', { delegationEnabled: true, verifierEnabled: true }));
    expect(await updateAgentFields('f1', { delegationEnabled: false })).toBe(true);
    expect(await updateAgentFields('f1', { lastActiveAt: '2026-10-06T01:00:00.000Z' })).toBe(true);
    const after = (await loadAgent('f1'))!;
    expect(after.delegationEnabled).toBe(false);
    expect(after.verifierEnabled).toBe(true);
    expect(after.status).toBe('running');
    expect(await updateAgentFields('f1', { openSubmissionEnabled: true })).toBe(true);
    expect((await loadAgent('f1'))?.openSubmissionEnabled).toBe(true);
    expect(after.lastActiveAt).toBe('2026-10-06T01:00:00.000Z');
  });

  it('encodes list and JSON columns the way saveAgent does', async () => {
    await saveAgent(agent('f2'));
    await updateAgentFields('f2', {
      capabilities: ['data-analysis'] as DeployedAgent['capabilities'],
      tools: [{ name: 't', description: 'd' }] as unknown as DeployedAgent['tools'],
      authorizedOwners: ['0xabc'],
      minReward: '5',
    });
    const after = (await loadAgent('f2'))!;
    expect(after.capabilities).toEqual(['data-analysis']);
    expect(after.tools).toEqual([{ name: 't', description: 'd' }]);
    expect(after.authorizedOwners).toEqual(['0xabc']);
    expect(after.minReward).toBe('5');
  });

  it('changes status only while it is still the expected one', async () => {
    await saveAgent(agent('f3'));
    await setAgentStatus('f3', 'stopped');
    // A late "it exited, so it stopped" must not touch an agent started since,
    // and a running→stopped flip finds nothing to flip here.
    expect(await setAgentStatus('f3', 'stopped', { from: 'running' })).toBe(false);
    await setAgentStatus('f3', 'running');
    expect(await setAgentStatus('f3', 'stopped', { from: 'running' })).toBe(true);
    expect((await loadAgent('f3'))?.status).toBe('stopped');
  });

  it('writes nothing for an unknown agent or an empty patch', async () => {
    expect(await updateAgentFields('nope', { status: 'stopped' })).toBe(false);
    expect(await loadAgent('nope')).toBeNull();
    await saveAgent(agent('f4'));
    expect(await updateAgentFields('f4', {})).toBe(false);
    expect(await updateAgentFields('f4', { instructions: undefined })).toBe(false);
  });
});

describe('targeted agent writes (Postgres)', () => {
  it('is a single-column UPDATE, never the whole-row upsert', async () => {
    await withPg(() => updateAgentFields('p1', { delegationEnabled: false }));
    const { sql, params } = pg.calls.at(-1)!;
    expect(sql).toBe('UPDATE deployed_agents SET delegation_enabled = $2, updated_at = NOW() WHERE id = $1');
    expect(params).toEqual(['p1', false]);
  });

  it('adds the status condition as its own placeholder', async () => {
    pg.rowCount = 0;
    try {
      expect(await withPg(() => setAgentStatus('p2', 'stopped', { from: 'running' }))).toBe(false);
    } finally {
      pg.rowCount = 1;
    }
    const { sql, params } = pg.calls.at(-1)!;
    expect(sql).toBe('UPDATE deployed_agents SET status = $2, updated_at = NOW() WHERE id = $1 AND status = $3');
    expect(params).toEqual(['p2', 'stopped', 'running']);
  });

  it('binds every placeholder, with the Postgres encodings saveAgent uses', async () => {
    await withPg(() => updateAgentFields('p3', {
      capabilities: ['data-analysis'] as DeployedAgent['capabilities'],
      tools: [] as DeployedAgent['tools'],
      verifierEnabled: true,
      lastActiveAt: '2026-10-06T01:00:00.000Z',
    }));
    const { sql, params } = pg.calls.at(-1)!;
    expect(sql).not.toMatch(/INSERT|ON CONFLICT/);
    const highest = Math.max(...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    expect(params).toHaveLength(highest);
    expect(params).toEqual(['p3', ['data-analysis'], '[]', true, '2026-10-06T01:00:00.000Z']);
  });
});
