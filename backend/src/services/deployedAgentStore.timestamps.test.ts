import { describe, expect, it, vi } from 'vitest';

/**
 * Postgres TIMESTAMPTZ columns come back from node-pg as Dates, but
 * DeployedAgent's deployedAt / lastActiveAt are strings, and reconcileAgents
 * sorts by deployedAt.localeCompare: with two or more running agents a backend
 * restart threw "x.deployedAt.localeCompare is not a function" (observed on
 * the local E2E stack). The store hands out ISO strings.
 */

const deployedAt = new Date('2026-10-02T11:37:40.271Z');
const lastActiveAt = new Date('2026-10-02T11:40:00.000Z');
const row = (id: string, last: Date | null) => ({
  id, owner_address: '0xowner', authorized_owners: '[]', name: id, instructions: 'x', provider: 'openai', model: 'm',
  api_key: '', encrypted_api_key: '', capabilities: [], tools: [], status: 'running', deployed_at: deployedAt,
  last_active_at: last, wallet_address: '0xwallet', public_key: '04ab', encrypted_private_key: '', verifier_enabled: false,
});

vi.mock('../config.js', () => ({ config: { databaseUrl: 'postgres://test' } }));
vi.mock('./database.js', () => ({ getDb: vi.fn() }));
vi.mock('./neonDb.js', () => ({
  getPool: async () => ({ query: async () => ({ rows: [row('a', lastActiveAt), row('b', null)], rowCount: 2 }) }),
}));

const { loadAllAgents } = await import('./deployedAgentStore.js');

describe('deployed agent timestamps from Postgres', () => {
  it('are ISO strings, so they sort as strings', async () => {
    const [a, b] = await loadAllAgents();
    expect(a.deployedAt).toBe('2026-10-02T11:37:40.271Z');
    expect(a.lastActiveAt).toBe('2026-10-02T11:40:00.000Z');
    expect(b.lastActiveAt).toBeUndefined();
    expect(() => [a, b].sort((x, y) => x.deployedAt.localeCompare(y.deployedAt))).not.toThrow();
  });
});
