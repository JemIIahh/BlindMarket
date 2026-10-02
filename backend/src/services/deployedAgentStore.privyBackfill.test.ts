import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Backfilling the deploying Privy user (docs/AGENT-GAS-FUNDING.md, "Who is
 * eligible") onto agents deployed before it was stored: only agents owned,
 * or co-owned, by one of the verified identity's wallets; never over an id
 * already there; and a save from a copy loaded earlier never clears it.
 * SQLite in memory always; Postgres when TEST_DATABASE_URL names a disposable
 * database (it creates and drops its own schema).
 */

const url = process.env.TEST_DATABASE_URL ?? '';
const pg = vi.hoisted(() => ({ on: false, pool: null as import('pg').Pool | null }));
vi.mock('../config.js', () => ({ config: { get databaseUrl() { return pg.on ? 'postgres://test' : ''; } } }));
vi.mock('./neonDb.js', () => ({ getPool: async () => pg.pool }));
vi.mock('better-sqlite3', async (importOriginal) => {
  const Real = (await importOriginal<{ default: new (path: string) => object }>()).default;
  return { default: class extends Real { constructor() { super(':memory:'); } } };
});

import { saveAgent, loadAgent, backfillPrivyUserId } from './deployedAgentStore.js';
import type { DeployedAgent } from '../types.js';

const OWNER = '0x' + 'aa'.repeat(20);
const CO_OWNER = '0x' + 'bb'.repeat(20);
const OTHER = '0x' + 'cc'.repeat(20);
const DID = 'did:privy:owner';

let seq = 0;
const agent = (extra: Partial<DeployedAgent> = {}): DeployedAgent => {
  const id = `bf-${++seq}`;
  return {
    id, ownerAddress: OWNER, name: id, instructions: 'x', provider: 'openai', model: 'm', apiKey: '', encryptedApiKey: '',
    capabilities: [], tools: [], status: 'stopped', deployedAt: '2026-10-02T00:00:00.000Z',
    walletAddress: `0x${seq.toString(16).padStart(40, '0')}`, publicKey: '04ab', encryptedPrivateKey: '', ...extra,
  };
};

function behaves(name: string) {
  describe(name, () => {
    it("fills the id on agents whose owner is one of the identity's wallets", async () => {
      const a = agent({ ownerAddress: OWNER.toUpperCase().replace('0X', '0x') });
      await saveAgent(a);
      const out = await backfillPrivyUserId(DID, [OTHER, OWNER]);
      expect(out.filled).toContain(a.id);
      expect((await loadAgent(a.id))?.privyUserId).toBe(DID);
    });

    it('fills it where one of the wallets is an authorized owner', async () => {
      const a = agent({ ownerAddress: OTHER, authorizedOwners: [CO_OWNER] });
      await saveAgent(a);
      expect((await backfillPrivyUserId(DID, [CO_OWNER])).filled).toEqual([a.id]);
    });

    it("leaves agents none of the identity's wallets owns", async () => {
      const a = agent({ ownerAddress: OTHER });
      await saveAgent(a);
      const out = await backfillPrivyUserId(DID, [OWNER, CO_OWNER]);
      expect(out.filled).not.toContain(a.id);
      expect((await loadAgent(a.id))?.privyUserId).toBeUndefined();
    });

    it('never overwrites an id already there, and reports the mismatch', async () => {
      const a = agent({ ownerAddress: '0x' + 'dd'.repeat(20), privyUserId: 'did:privy:first' });
      await saveAgent(a);
      const out = await backfillPrivyUserId(DID, ['0x' + 'dd'.repeat(20)]);
      expect(out).toEqual({ filled: [], mismatched: [{ id: a.id, privyUserId: 'did:privy:first' }] });
      expect((await loadAgent(a.id))?.privyUserId).toBe('did:privy:first');
    });

    it('keeps a backfilled id when a copy loaded before it is saved', async () => {
      const a = agent({ ownerAddress: '0x' + 'ee'.repeat(20) });
      await saveAgent(a);
      const stale = (await loadAgent(a.id))!;
      await backfillPrivyUserId(DID, ['0x' + 'ee'.repeat(20)]);
      await saveAgent({ ...stale, status: 'running' });
      expect(await loadAgent(a.id)).toMatchObject({ status: 'running', privyUserId: DID });
    });

    it('does nothing without an id or a wallet', async () => {
      expect(await backfillPrivyUserId('', [OWNER])).toEqual({ filled: [], mismatched: [] });
      expect(await backfillPrivyUserId(DID, ['agent', ''])).toEqual({ filled: [], mismatched: [] });
    });
  });
}

behaves('backfillPrivyUserId on SQLite');

describe.skipIf(!url)('on Postgres', () => {
  beforeAll(async () => {
    const { default: PG } = await import('pg');
    const admin = new PG.Pool({ connectionString: url, ssl: false });
    await admin.query('DROP SCHEMA IF EXISTS privy_backfill_test CASCADE; CREATE SCHEMA privy_backfill_test');
    await admin.end();
    pg.pool = new PG.Pool({ connectionString: url, ssl: false, options: '-c search_path=privy_backfill_test' });
    await pg.pool.query(`CREATE TABLE deployed_agents (
      id TEXT PRIMARY KEY, owner_address TEXT NOT NULL, authorized_owners TEXT[] NOT NULL DEFAULT '{}', name TEXT, instructions TEXT,
      provider TEXT, model TEXT, api_key TEXT, encrypted_api_key TEXT, capabilities TEXT[] DEFAULT '{}', tools JSONB DEFAULT '[]',
      status TEXT, deployed_at TEXT, last_active_at TEXT, storage_ref TEXT, platform_token TEXT, wallet_address TEXT,
      smart_account_address TEXT, public_key TEXT, encrypted_private_key TEXT, raw_private_key TEXT, inft_token_id TEXT,
      min_reward TEXT, skills JSONB, tool_secrets JSONB, encrypted_tool_secrets JSONB, verifier_enabled BOOLEAN,
      delegation_enabled BOOLEAN, privy_user_id TEXT, updated_at TIMESTAMPTZ)`);
  });
  afterAll(async () => {
    await pg.pool?.query('DROP SCHEMA IF EXISTS privy_backfill_test CASCADE');
    await pg.pool?.end();
    pg.on = false;
  });
  beforeEach(() => {
    pg.on = true;
  });
  behaves('backfillPrivyUserId');
});
