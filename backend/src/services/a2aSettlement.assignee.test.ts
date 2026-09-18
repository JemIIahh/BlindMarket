import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The escrow records ONE worker address, and only that address can submit
 * evidence. Found end to end on Base Sepolia (2026-09-18): the backend named
 * the agent's smart account whenever it had one, while the worker only takes
 * the UserOp path with an entry point AND a bundler configured. With no
 * bundler the worker signed as its EOA and every submitEvidence reverted
 * NotWorker(), after the work was done.
 */

const cfg = vi.hoisted(() => ({ entryPointAddress: '0xEntryPoint', pimlicoBundlerUrl: 'https://bundler.test' }));
vi.mock('../config.js', () => ({ config: cfg }));
vi.mock('./chain.js', () => ({ provider: {}, baseProvider: {}, escrow: {}, baseEscrow: {} }));
vi.mock('./taskChain.js', () => ({ resolveTaskByHash: vi.fn() }));
vi.mock('./a2aStore.js', () => ({ updateState: vi.fn() }));
vi.mock('./socket.js', () => ({ rooms: {} }));
const loadAgentByWallet = vi.fn();
vi.mock('./deployedAgentStore.js', () => ({ loadAgentByWallet: (...a: unknown[]) => loadAgentByWallet(...a) }));

const { resolveAssignee, smartAccountSubmitUsable } = await import('./a2aSettlement.js');

const EOA = '0x8E08dD7313c9658700d5c2b559a30B67FAE6fd9C';
const SMART = '0x9fFc618776D03e10611766E2EdfB723390056dFC';

beforeEach(() => {
  cfg.entryPointAddress = '0xEntryPoint';
  cfg.pimlicoBundlerUrl = 'https://bundler.test';
  loadAgentByWallet.mockReset().mockResolvedValue({ smartAccountAddress: SMART });
});

describe('resolveAssignee', () => {
  it('names the smart account on Base when the worker can submit through it', async () => {
    expect(smartAccountSubmitUsable()).toBe(true);
    expect(await resolveAssignee(EOA, 'base')).toBe(SMART);
  });

  it('names the EOA when no bundler is configured, even if a smart account exists', async () => {
    cfg.pimlicoBundlerUrl = '';
    expect(smartAccountSubmitUsable()).toBe(false);
    expect(await resolveAssignee(EOA, 'base')).toBe(EOA);
    expect(loadAgentByWallet).not.toHaveBeenCalled();
  });

  it('names the EOA when no entry point is configured', async () => {
    cfg.entryPointAddress = '';
    expect(await resolveAssignee(EOA, 'base')).toBe(EOA);
  });

  it('names the EOA on 0G and for agents with no smart account', async () => {
    expect(await resolveAssignee(EOA, '0g')).toBe(EOA);
    loadAgentByWallet.mockResolvedValue({ smartAccountAddress: undefined });
    expect(await resolveAssignee(EOA, 'base')).toBe(EOA);
  });
});
