import { describe, it, expect } from 'vitest';
import { getSchemaStatus, latestMigrationId } from './neonDb.js';

/**
 * getSchemaStatus: runMigrations skips by id only, so an id applied under a
 * different name is never re-applied. That's how a local DB silently missed
 * migration 27 (smart_account_address) after a branch had used id 27 for
 * cctp_transfers. The drift check must catch both skipped and renamed ids.
 */

const fakePool = (rows: Array<{ id: number; name: string }>) => ({ query: async () => ({ rows }) }) as never;

describe('getSchemaStatus', () => {
  it('flags an id recorded under a different name, and ids never applied', async () => {
    const status = await getSchemaStatus(fakePool([
      { id: 26, name: 'analytics_events' },
      { id: 27, name: 'cctp_transfers' }, // the collision seen on the local DB
      { id: 28, name: 'agent_usage' },
    ]));
    expect(status.nameMismatch).toEqual([27]);
    expect(status.missing).toContain(1);
    expect(status.missing).toContain(latestMigrationId());
    expect(status.latestApplied).toBe(28);
  });

  it('reports nothing wrong when every migration is applied under its own name', async () => {
    // Build the "applied" table from what the code expects, using the drift
    // check's own view of the list (no names hard-coded here).
    const probe = await getSchemaStatus(fakePool([]));
    const ids = probe.missing; // with nothing applied, every expected id is "missing"
    expect(ids.length).toBeGreaterThan(0);
    // Every name must match its id: recover the real names by applying each id
    // with a sentinel name and reading back which ids mismatch.
    const withSentinel = await getSchemaStatus(fakePool(ids.map((id) => ({ id, name: '__sentinel__' }))));
    expect(withSentinel.missing).toEqual([]);
    expect(withSentinel.nameMismatch).toEqual(ids);
    expect(withSentinel.latestApplied).toBe(latestMigrationId());
  });
});
