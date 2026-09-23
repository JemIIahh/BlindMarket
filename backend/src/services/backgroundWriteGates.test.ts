/**
 * The CCTP poller and the AgentFactory listener check
 * backgroundWritesAllowed() on every tick, not only at start, so a process
 * that learns late it is on another deployment's Redis stops writing
 * (deploymentIdentity.ts). The indexers', sweeps' and agent runner's gates
 * are tested with their own suites.
 *
 * Run: npx vitest run src/services/backgroundWriteGates.test.ts
 */
import { describe, it, expect, vi } from 'vitest';

const { gate, listNonTerminal, arcProvider } = vi.hoisted(() => ({
  gate: { allowed: false },
  listNonTerminal: vi.fn(async () => []),
  arcProvider: { getBlockNumber: vi.fn(async () => 100) },
}));

vi.mock('./deploymentIdentity.js', () => ({ backgroundWritesAllowed: () => gate.allowed }));
vi.mock('../config.js', () => ({
  config: { cctp: { irisApiBase: 'https://iris.test' }, arcAgentFactoryAddress: '0x' + 'af'.repeat(20) },
}));
vi.mock('./cctpChains.js', () => ({ isCctpConfigured: () => true, getCctpChain: vi.fn() }));
vi.mock('./cctp.js', () => ({ pollIrisAttestation: vi.fn() }));
vi.mock('./cctpTransferStore.js', () => ({ listNonTerminal, updateTransfer: vi.fn() }));
vi.mock('./chain.js', () => ({ arcProvider }));
vi.mock('./redis.js', () => ({ redis: { get: vi.fn(async () => null), set: vi.fn() } }));

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("on another deployment's Redis", () => {
  it('the CCTP poller does not read or advance transfers', async () => {
    const { startCctpAttestationPoller, stopCctpAttestationPoller } = await import('./cctpAttestationPoller.js');
    startCctpAttestationPoller();
    await settle();
    stopCctpAttestationPoller();
    expect(listNonTerminal).not.toHaveBeenCalled();
  });

  it('the AgentFactory listener does not scan for deploys', async () => {
    const { startAgentFactoryListener, stopAgentFactoryListener } = await import('./agentFactoryListener.js');
    startAgentFactoryListener();
    await settle();
    stopAgentFactoryListener();
    expect(arcProvider.getBlockNumber).not.toHaveBeenCalled();
  });

  it('both run again once the gate opens (the check answered later)', async () => {
    gate.allowed = true;
    vi.resetModules();
    const cctp = await import('./cctpAttestationPoller.js');
    const factory = await import('./agentFactoryListener.js');
    cctp.startCctpAttestationPoller();
    factory.startAgentFactoryListener();
    await settle();
    cctp.stopCctpAttestationPoller();
    factory.stopAgentFactoryListener();
    expect(listNonTerminal).toHaveBeenCalled();
    expect(arcProvider.getBlockNumber).toHaveBeenCalled();
  });
});
