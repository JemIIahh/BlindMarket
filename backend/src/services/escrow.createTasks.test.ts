/**
 * buildCreateTasksOn builds one createTasks for several tasks
 * (docs/BULK-POSTING.md). A batch costs about 202k gas per task, so its gas
 * limit comes from an estimate, or from a size-aware fallback, never from a
 * single task's.
 *
 * Run: npx vitest run src/services/escrow.createTasks.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';

const { chain } = vi.hoisted(() => ({ chain: {} as Record<string, unknown> }));
vi.mock('./chain.js', () => chain);
vi.mock('../config.js', () => ({ config: { baseChainId: 84532, arcChainId: 5042002 } }));

const { buildCreateTasksOn, createTasksGasFallback, TX_GAS_CAP } = await import('./escrow.js');

const abi = JSON.parse(readFileSync(new URL('../abi/BlindEscrow.json', import.meta.url), 'utf-8'));
const iface = new ethers.Interface(Array.isArray(abi) ? abi : abi.abi);
const ARC_ESCROW = '0xaaaa000000000000000000000000000000000001';
const USDC = '0x3600000000000000000000000000000000000000';
const POSTER = '0x1111111111111111111111111111111111111111';
const VERIFIER = '0x4444444444444444444444444444444444444444';

const estimateGas = vi.fn();

function input(i: number, over: Record<string, unknown> = {}) {
  return {
    taskHash: '0x' + (i + 1).toString(16).padStart(64, '0'),
    amount: 1_000_000n * BigInt(i + 1),
    category: 'general',
    locationZone: 'global',
    duration: 86_400n,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(chain, {
    arcEscrow: new ethers.Contract(ARC_ESCROW, iface),
    arcProvider: { estimateGas },
    baseEscrow: null,
    baseProvider: {},
    buildUnsignedTx: async (contract: ethers.Contract, method: string, args: unknown[], from: string) => ({
      to: await contract.getAddress(),
      data: contract.interface.encodeFunctionData(method, args),
      from: ethers.getAddress(from),
    }),
  });
});

describe('buildCreateTasksOn', () => {
  it('encodes every task in order, for the token, with no value, on the chain named', async () => {
    estimateGas.mockResolvedValue(1_000_000n);
    const tx = await buildCreateTasksOn('arc', POSTER, USDC, [input(0), input(1, { verifierAgent: VERIFIER })]);
    expect(tx.to).toBe(ARC_ESCROW);
    expect(tx.value).toBeUndefined();
    expect(tx.chainId).toBe(5042002);
    const parsed = iface.parseTransaction({ data: tx.data as string })!;
    expect(parsed.name).toBe('createTasks');
    expect(parsed.selector).toBe('0x0f22c9c8');
    expect(parsed.args[0]).toBe(USDC);
    const tasks = parsed.args[1] as ethers.Result[];
    expect(tasks.map((t) => [t.taskHash, t.amount, t.category, t.locationZone, t.duration, t.verifierAgent])).toEqual([
      [input(0).taskHash, 1_000_000n, 'general', 'global', 86_400n, ethers.ZeroAddress],
      [input(1).taskHash, 2_000_000n, 'general', 'global', 86_400n, VERIFIER],
    ]);
  });

  it('sets the gas limit from the estimate as the poster, plus a fifth', async () => {
    estimateGas.mockResolvedValue(1_000_000n);
    const tx = await buildCreateTasksOn('arc', POSTER, USDC, [input(0), input(1)]);
    expect(estimateGas).toHaveBeenCalledWith({ from: POSTER, to: ARC_ESCROW, data: tx.data });
    expect(tx.gasLimit).toBe(1_200_000);
  });

  it('falls back to a size-aware limit when the estimate reverts (the approval may come after the build)', async () => {
    estimateGas.mockRejectedValue(Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION' }));
    const inputs = Array.from({ length: 10 }, (_, i) => input(i));
    const tx = await buildCreateTasksOn('arc', POSTER, USDC, inputs);
    expect(tx.gasLimit).toBe(Number(createTasksGasFallback(inputs)));
    // 10 tasks at the measured ~202k each plus 57k, with room to spare, and
    // far above one task's limit.
    expect(tx.gasLimit).toBeGreaterThan(10 * 202_000 + 57_000);
  });

  it('never asks for more than the per-transaction gas cap', async () => {
    estimateGas.mockResolvedValue(16_000_000n);
    const tx = await buildCreateTasksOn('arc', POSTER, USDC, [input(0)]);
    expect(tx.gasLimit).toBe(Number(TX_GAS_CAP));
  });

  it('refuses a chain with no escrow', async () => {
    await expect(buildCreateTasksOn('base', POSTER, USDC, [input(0)])).rejects.toThrow(/escrow not configured/);
  });
});

describe('createTasksGasFallback', () => {
  it('grows with the batch: about 210k a task plus 100k, and a fifth on top', () => {
    expect(createTasksGasFallback([input(0)])).toBe(((100_000n + 210_000n) * 120n) / 100n);
    expect(createTasksGasFallback(Array.from({ length: 50 }, (_, i) => input(i)))).toBe(((100_000n + 50n * 210_000n) * 120n) / 100n);
  });

  it('adds a storage word per 32 bytes of a long locationZone, and a slot for a verifier', () => {
    const short = createTasksGasFallback([input(0)]);
    expect(createTasksGasFallback([input(0, { locationZone: 'z'.repeat(31) })])).toBe(short);
    expect(createTasksGasFallback([input(0, { locationZone: 'z'.repeat(128) })])).toBe(short + (4n * 25_000n * 120n) / 100n);
    expect(createTasksGasFallback([input(0, { verifierAgent: VERIFIER })])).toBe(short + (30_000n * 120n) / 100n);
    expect(createTasksGasFallback([input(0, { verifierAgent: ethers.ZeroAddress })])).toBe(short);
  });

  it('is capped at 2^24', () => {
    const heavy = Array.from({ length: 50 }, (_, i) => input(i, { locationZone: 'z'.repeat(128), verifierAgent: VERIFIER }));
    expect(createTasksGasFallback(heavy)).toBe(TX_GAS_CAP);
    expect(TX_GAS_CAP).toBe(16_777_216n);
  });
});
