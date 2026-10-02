import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * sameOwnerAddresses is the one answer to "who may not take a sub-task this
 * poster posted": /accept (sameOwnerSubtask) and the cascade
 * (agentScorer.barredFromTask) both read it, so the cascade never offers a
 * task accept would refuse.
 */

const hosted = vi.hoisted(() => new Map<string, Record<string, unknown>>());
const walletsOfOwners = vi.hoisted(() => vi.fn(async (_owners: string[]) => [] as string[]));
vi.mock('./deployedAgentStore.js', () => ({
  loadAgentByWallet: vi.fn(async (a: string) => hosted.get(a.toLowerCase()) ?? null),
  loadAgentBySmartAccount: vi.fn(async () => null),
  walletsOfOwners,
}));

import { sameOwnerAddresses, sameOwnerSubtask } from './delegationGuard.js';

const POSTER = '0x9090000000000000000000000000000000000002';
const SIBLING = '0x5b1b000000000000000000000000000000000003';

beforeEach(() => {
  hosted.clear();
  walletsOfOwners.mockReset().mockResolvedValue([]);
});

describe('sameOwnerAddresses', () => {
  it("is the hosted poster's owners plus every agent they own or are linked to", async () => {
    hosted.set(POSTER, { id: 'p', ownerAddress: '0xOwnerA', authorizedOwners: ['0xlinked'], walletAddress: POSTER });
    walletsOfOwners.mockResolvedValue([POSTER, SIBLING]);
    expect(await sameOwnerAddresses(POSTER)).toEqual(new Set(['0xownera', '0xlinked', POSTER, SIBLING]));
    expect(walletsOfOwners).toHaveBeenCalledTimes(1);
    expect(walletsOfOwners).toHaveBeenCalledWith(['0xownera', '0xlinked']);
  });

  it('is empty for a poster that is not a hosted agent, with no owner query', async () => {
    expect(await sameOwnerAddresses('0x0000000000000000000000000000000000000a11')).toEqual(new Set());
    expect(walletsOfOwners).not.toHaveBeenCalled();
  });

  it('is what /accept checks, whatever the case of the executor address', async () => {
    hosted.set(POSTER, { id: 'p', ownerAddress: '0xownera', walletAddress: POSTER });
    walletsOfOwners.mockResolvedValue([POSTER, SIBLING]);
    expect(await sameOwnerSubtask(POSTER, SIBLING.toUpperCase().replace('0X', '0x'))).toBe(true);
    expect(await sameOwnerSubtask(POSTER, '0xOWNERA')).toBe(true);
    expect(await sameOwnerSubtask(POSTER, '0x5c1c000000000000000000000000000000000004')).toBe(false);
  });
});
