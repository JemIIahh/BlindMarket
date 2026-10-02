import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Who may trigger the Privy-user backfill (privyBackfill.ts): a verified
 * Privy token, with its own linked wallets — never an sk_ API key or an
 * agent's HS256 token. The store's matching rules are tested in
 * deployedAgentStore.privyBackfill.test.ts.
 */

const backfill = vi.hoisted(() => vi.fn(async () => ({ filled: [] as string[], mismatched: [] as Array<{ id: string; privyUserId: string }> })));
vi.mock('./deployedAgentStore.js', () => ({ backfillPrivyUserId: backfill }));

const { backfillOwnerPrivyId, _resetPrivyBackfill } = await import('./privyBackfill.js');

beforeEach(() => {
  backfill.mockClear();
  _resetPrivyBackfill();
});

describe('backfillOwnerPrivyId', () => {
  it("backfills for a verified Privy user, over all of that user's linked wallets", async () => {
    await backfillOwnerPrivyId({ address: '0xa', addresses: ['0xa', '0xb'], privyUserId: 'did:privy:u' });
    expect(backfill).toHaveBeenCalledWith('did:privy:u', ['0xa', '0xa', '0xb']);
  });

  it('never for an sk_ API key or an agent token', async () => {
    await backfillOwnerPrivyId({ address: '0xa', addresses: ['0xa'] }); // sk_ key: no Privy identity
    await backfillOwnerPrivyId({ address: '0xa', typ: 'agent-registration' });
    await backfillOwnerPrivyId({ address: '0xa', typ: 'agent-platform', privyUserId: 'did:privy:forged' });
    expect(backfill).not.toHaveBeenCalled();
  });

  it('runs at most every ten minutes per user, and again after a failure', async () => {
    const user = { address: '0xa', privyUserId: 'did:privy:u' };
    await backfillOwnerPrivyId(user, 1_000_000);
    await backfillOwnerPrivyId(user, 1_000_000 + 60_000);
    expect(backfill).toHaveBeenCalledTimes(1);
    await backfillOwnerPrivyId(user, 1_000_000 + 10 * 60_000 + 1);
    expect(backfill).toHaveBeenCalledTimes(2);
    backfill.mockRejectedValueOnce(new Error('db down'));
    await backfillOwnerPrivyId({ address: '0xc', privyUserId: 'did:privy:v' }, 5_000_000);
    await backfillOwnerPrivyId({ address: '0xc', privyUserId: 'did:privy:v' }, 5_000_001);
    expect(backfill).toHaveBeenCalledTimes(4);
  });
});
