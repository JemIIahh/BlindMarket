/**
 * Chain routing for the worker's evidence submission.
 *
 * A task must reach Submitted on the chain it was escrowed on. A Base task's
 * `submitEvidence` aimed at the Arc escrow (or vice versa) reverts, or silently
 * no-ops when the wallet sits on the other network, and the task can never
 * reach Submitted.
 *
 * Run: npx vitest run src/services/escrow.submitEvidence.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const arcEscrowStub = { id: 'arc-escrow' };
const baseEscrowStub = { id: 'base-escrow' };
const buildUnsignedTx = vi.fn(
  async (_contract: unknown, _method: string, _args: unknown[], _from: string) => ({
    to: '0xto',
    data: '0xdata',
    from: '0xfrom',
  }),
);

vi.mock('./chain.js', () => ({
  arcEscrow: arcEscrowStub,
  baseEscrow: baseEscrowStub,
  buildUnsignedTx,
}));
vi.mock('../config.js', () => ({ config: { baseChainId: 84532, arcChainId: 5042002 } }));

const { buildSubmitEvidenceOn } =
  await import('./escrow.js');

const WORKER = '0x1111111111111111111111111111111111111111';
const EVIDENCE = '0xdeadbeef';

beforeEach(() => vi.clearAllMocks());

describe('buildSubmitEvidenceOn', () => {
  it('builds against the Base escrow for a Base-funded task', async () => {
    await buildSubmitEvidenceOn('base', WORKER, 7, EVIDENCE);

    const [contract, method, args] = buildUnsignedTx.mock.calls[0];
    expect(contract).toBe(baseEscrowStub);
    expect(method).toBe('submitEvidence');
    expect(args).toEqual([7, EVIDENCE]);
  });

  it('builds against the Arc escrow for an Arc-funded task', async () => {
    await buildSubmitEvidenceOn('arc', WORKER, 7, EVIDENCE);

    expect(buildUnsignedTx.mock.calls[0][0]).toBe(arcEscrowStub);
  });

  it('never aims a Base task at the Arc escrow', async () => {
    // The regression itself: same id, two chains, one correct contract.
    await buildSubmitEvidenceOn('base', WORKER, 3, EVIDENCE);
    await buildSubmitEvidenceOn('arc', WORKER, 3, EVIDENCE);

    expect(buildUnsignedTx.mock.calls[0][0]).not.toBe(buildUnsignedTx.mock.calls[1][0]);
  });

  it('pins the Base chainId onto a Base submitEvidence', async () => {
    const tx = await buildSubmitEvidenceOn('base', WORKER, 7, EVIDENCE);
    expect(tx.chainId).toBe(84532);
  });

  it('pins the Arc chainId onto an Arc submitEvidence', async () => {
    const tx = await buildSubmitEvidenceOn('arc', WORKER, 7, EVIDENCE);
    expect(tx.chainId).toBe(5042002);
  });

  it('keeps to/data/from from the builder alongside the chainId', async () => {
    const tx = await buildSubmitEvidenceOn('base', WORKER, 7, EVIDENCE);
    expect(tx).toMatchObject({ to: '0xto', data: '0xdata', from: '0xfrom', chainId: 84532 });
  });
});

describe('buildSubmitEvidence (defaults to the posting chain)', () => {
  it('refuses to build when Base is not configured', async () => {
    vi.resetModules();
    vi.doMock('./chain.js', () => ({ baseEscrow: null, arcEscrow: arcEscrowStub, buildUnsignedTx }));
    const { buildSubmitEvidenceOn: unconfigured } = await import('./escrow.js');

    await expect(unconfigured('base', WORKER, 7, EVIDENCE)).rejects.toThrow('BASE_CHAIN_ID=84532 record');
    expect(buildUnsignedTx).not.toHaveBeenCalled();
    vi.doUnmock('./chain.js');
  });
});
