/**
 * The reads behind POST /tasks/:id/timeout (security audit run 1, C18/C36).
 * A contract revert (ethers CALL_EXCEPTION, with `revert` decoded from the
 * escrow ABI) is an answer; any other failure is an RPC problem and throws.
 * The shapes below are what ethers 6 produced against the upgraded escrow and
 * against a contract without these functions (an escrow from before the
 * upgrade) on a Hardhat chain.
 *
 * Run: npx vitest run src/services/escrow.claimTimeout.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const POSTER = '0x1111111111111111111111111111111111111111';

const arcEscrow = vi.hoisted(() => {
  const claimTimeout = Object.assign(vi.fn(), { staticCall: vi.fn() });
  return { claimTimeout, effectiveDeadline: vi.fn(), unjudgedEscalation: vi.fn() };
});

vi.mock('./chain.js', () => ({ arcEscrow, baseEscrow: null, buildUnsignedTx: vi.fn() }));
vi.mock('../config.js', () => ({ config: { baseChainId: 84532, arcChainId: 5042002 } }));

const { claimTimeoutRevertOn, effectiveDeadlineOn, escalatesUnjudgedWorkOn } = await import('./escrow.js');

const reverted = (name?: string) =>
  Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION', revert: name ? { name } : null });
const rpcDown = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'NETWORK_ERROR' });

beforeEach(() => vi.clearAllMocks());

describe('claimTimeoutRevertOn', () => {
  it('is null when the escrow would accept the claim, dry-run as the poster', async () => {
    arcEscrow.claimTimeout.staticCall.mockResolvedValue(undefined);
    expect(await claimTimeoutRevertOn('arc', POSTER.toUpperCase().replace('0X', '0x'), 7)).toBeNull();
    expect(arcEscrow.claimTimeout.staticCall).toHaveBeenCalledWith(7, { from: POSTER });
  });

  it("names the escrow's custom error", async () => {
    arcEscrow.claimTimeout.staticCall.mockRejectedValue(reverted('AppealWindowActive'));
    expect(await claimTimeoutRevertOn('arc', POSTER, 7)).toBe('AppealWindowActive');
  });

  it("says 'reverted' for a revert it cannot decode", async () => {
    arcEscrow.claimTimeout.staticCall.mockRejectedValue(reverted());
    expect(await claimTimeoutRevertOn('arc', POSTER, 7)).toBe('reverted');
  });

  it('throws on an RPC failure instead of calling it a refusal', async () => {
    arcEscrow.claimTimeout.staticCall.mockRejectedValue(rpcDown());
    await expect(claimTimeoutRevertOn('arc', POSTER, 7)).rejects.toThrow('ECONNREFUSED');
  });
});

describe('effectiveDeadlineOn / escalatesUnjudgedWorkOn', () => {
  it('read the upgraded escrow', async () => {
    arcEscrow.effectiveDeadline.mockResolvedValue(1_790_303_277n);
    arcEscrow.unjudgedEscalation.mockResolvedValue(false);
    expect(await effectiveDeadlineOn('arc', 7)).toBe(1_790_303_277n);
    expect(await escalatesUnjudgedWorkOn('arc', 7)).toBe(true);
  });

  it('fall back on an escrow from before the upgrade (no such function: a bare revert)', async () => {
    arcEscrow.effectiveDeadline.mockRejectedValue(reverted());
    arcEscrow.unjudgedEscalation.mockRejectedValue(reverted());
    expect(await effectiveDeadlineOn('arc', 7)).toBeNull();
    expect(await escalatesUnjudgedWorkOn('arc', 7)).toBe(false);
  });

  it('throw on an RPC failure, so a flaky node never passes for an old escrow', async () => {
    arcEscrow.effectiveDeadline.mockRejectedValue(rpcDown());
    arcEscrow.unjudgedEscalation.mockRejectedValue(rpcDown());
    await expect(effectiveDeadlineOn('arc', 7)).rejects.toThrow();
    await expect(escalatesUnjudgedWorkOn('arc', 7)).rejects.toThrow();
  });
});
