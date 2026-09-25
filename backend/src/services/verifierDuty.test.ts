import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./deployedAgentStore.js', () => ({
  loadAgentByWallet: vi.fn(async () => null),
  loadAgentBySmartAccount: vi.fn(async () => null),
  loadAllAgents: vi.fn(async () => []),
}));

import { activeHostedVerifiers, hostedVerifierNotOptedIn } from './verifierDuty.js';
import { loadAgentBySmartAccount, loadAgentByWallet, loadAllAgents } from './deployedAgentStore.js';

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

describe('activeHostedVerifiers', () => {
  it('keeps agents that opted in and are running, keyed by wallet and smart account', async () => {
    vi.mocked(loadAllAgents).mockResolvedValueOnce([
      { name: 'on', verifierEnabled: true, status: 'running', walletAddress: '0xAAAA', smartAccountAddress: '0xBBBB' },
      { name: 'stopped', verifierEnabled: true, status: 'stopped', walletAddress: '0xCCCC' },
      { name: 'paused', verifierEnabled: true, status: 'paused', walletAddress: '0xDDDD' },
      { name: 'not opted in', verifierEnabled: false, status: 'running', walletAddress: '0xEEEE' },
      { name: 'legacy', status: 'running', walletAddress: '0xFFFF' },
    ] as any);
    const set = await activeHostedVerifiers();
    expect([...set.keys()]).toEqual(['0xaaaa', '0xbbbb']);
    expect(set.get('0xbbbb')?.name).toBe('on');
  });
});
