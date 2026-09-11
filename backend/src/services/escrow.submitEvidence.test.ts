/**
 * Chain routing for the worker's evidence submission.
 *
 * Every read in the /submit handler was made chain-aware when task creation
 * moved to Base, but the transaction the worker actually signs was still built
 * against the 0G escrow. A Base task's `submitEvidence` therefore carried the
 * Base task id and the 0G contract address: it reverts, or silently no-ops when
 * the wallet sits on the other network, and the task can never reach Submitted.
 *
 * Run: npx vitest run src/services/escrow.submitEvidence.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ogEscrow = { id: '0g-escrow' };
const baseEscrowStub = { id: 'base-escrow' };
const buildUnsignedTx = vi.fn(
  async (_contract: unknown, _method: string, _args: unknown[], _from: string) => ({
    to: '0xto',
    data: '0xdata',
    from: '0xfrom',
  }),
);

vi.mock('./chain.js', () => ({
  escrow: ogEscrow,
  baseEscrow: baseEscrowStub,
  buildUnsignedTx,
}));
vi.mock('../config.js', () => ({ config: { baseChainId: 84532, ogChainId: 16602 } }));

const { buildSubmitEvidenceOn, buildSubmitEvidence } =
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

  it('builds against the 0G escrow for a 0G-funded task', async () => {
    await buildSubmitEvidenceOn('0g', WORKER, 7, EVIDENCE);

    expect(buildUnsignedTx.mock.calls[0][0]).toBe(ogEscrow);
  });

  it('never aims a Base task at the 0G escrow', async () => {
    // The regression itself: same id, two chains, one correct contract.
    await buildSubmitEvidenceOn('base', WORKER, 3, EVIDENCE);
    await buildSubmitEvidence(WORKER, 3, EVIDENCE);

    expect(buildUnsignedTx.mock.calls[0][0]).not.toBe(buildUnsignedTx.mock.calls[1][0]);
  });
});

describe('buildSubmitEvidenceBase', () => {
  it('refuses to build when Base is not configured', async () => {
    vi.resetModules();
    vi.doMock('./chain.js', () => ({ escrow: ogEscrow, baseEscrow: null, buildUnsignedTx }));
    const { buildSubmitEvidenceBase: unconfigured } = await import('./escrow.js');

    await expect(unconfigured(WORKER, 7, EVIDENCE)).rejects.toThrow('BASE_ESCROW_ADDRESS');
    expect(buildUnsignedTx).not.toHaveBeenCalled();
    vi.doUnmock('./chain.js');
  });

  // The unsigned tx used to carry no chainId at all, so a Base submitEvidence
  // handed to a signer bound to the 0G RPC was simply broadcast there — the
  // worker had one signer, and a deployed agent could accept a Base task and
  // never deliver it. Pinning chainId makes ethers refuse the wrong network
  // at the signer, whichever client picked it.
  it('pins the Base chainId onto a Base submitEvidence', async () => {
    const tx = await buildSubmitEvidenceOn('base', WORKER, 7, EVIDENCE);
    expect(tx.chainId).toBe(84532);
  });

  it('pins the 0G chainId onto a 0G submitEvidence', async () => {
    const tx = await buildSubmitEvidenceOn('0g', WORKER, 7, EVIDENCE);
    expect(tx.chainId).toBe(16602);
  });

  it('keeps to/data/from from the builder alongside the chainId', async () => {
    const tx = await buildSubmitEvidenceOn('base', WORKER, 7, EVIDENCE);
    expect(tx).toMatchObject({ to: '0xto', data: '0xdata', from: '0xfrom', chainId: 84532 });
  });
});
