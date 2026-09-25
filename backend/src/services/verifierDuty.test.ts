import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./deployedAgentStore.js', () => ({
  loadAgentByWallet: vi.fn(async () => null),
  loadAgentBySmartAccount: vi.fn(async () => null),
}));

import { hostedVerifierNotOptedIn } from './verifierDuty.js';
import { loadAgentBySmartAccount, loadAgentByWallet } from './deployedAgentStore.js';

const ADDR = '0x1234000000000000000000000000000000000001';

beforeEach(() => vi.clearAllMocks());

describe('hostedVerifierNotOptedIn (audit run 1, C04)', () => {
  it('flags a hosted agent that has not opted in, by wallet or smart account', async () => {
    vi.mocked(loadAgentByWallet).mockResolvedValueOnce({ id: 'a', verifierEnabled: false } as any);
    expect(await hostedVerifierNotOptedIn(ADDR)).toBe(true);
    vi.mocked(loadAgentBySmartAccount).mockResolvedValueOnce({ id: 'b' } as any);
    expect(await hostedVerifierNotOptedIn(ADDR)).toBe(true);
  });

  it('lets through a hosted agent that opted in', async () => {
    vi.mocked(loadAgentByWallet).mockResolvedValueOnce({ id: 'a', verifierEnabled: true } as any);
    expect(await hostedVerifierNotOptedIn(ADDR)).toBe(false);
  });

  it('leaves addresses that are not hosted agents alone', async () => {
    expect(await hostedVerifierNotOptedIn(ADDR)).toBe(false);
  });
});
