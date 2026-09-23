import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ethers } from 'ethers';

/**
 * The deploy fee on Arc: at least the fee in USDC sent from one of the
 * deployer's wallets to the Arc escrow's treasury. The web app connects to
 * Arc only, so before this the fee (AgentFactory, Base only) could not be
 * paid and no one could deploy an agent.
 */

const USDC = '0x3600000000000000000000000000000000000000';
const TREASURY = '0x2f8b1177c83623a560B26B38dE984e154b123D75';
const OLD_TREASURY = '0x7777777777777777777777777777777777777777';
const OWNER = '0x1111111111111111111111111111111111111111';
const STRANGER = '0x9999999999999999999999999999999999999999';
const TX = '0x' + 'ab'.repeat(32);

const cfg = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock('../config.js', () => ({ config: cfg }));

const chain = vi.hoisted(() => ({
  getTransactionReceipt: vi.fn(),
  getTransaction: vi.fn(),
  treasury: vi.fn(),
  escrow: true,
}));
vi.mock('./chainRuntime.js', () => ({
  chainRuntime: () => ({
    provider: { getTransactionReceipt: chain.getTransactionReceipt, getTransaction: chain.getTransaction },
    escrow: chain.escrow ? { treasury: chain.treasury } : null,
  }),
}));

const store = vi.hoisted(() => new Map<string, string>());
vi.mock('./redis.js', () => ({
  redis: {
    set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
      if (args.includes('NX') && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
  },
}));

const {
  arcDeployFeeTerms, verifyArcDeployFee, claimArcDeployFee, markArcDeployFeeUsed, releaseArcDeployFee, _resetDeployFeeCache,
} = await import('./deployFee.js');

const TRANSFER = ethers.id('Transfer(address,address,uint256)');
const word = (address: string) => ethers.zeroPadValue(address, 32);
const amount = (raw: bigint) => ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [raw]);

function transferLog(from: string, to: string, raw: bigint, token = USDC) {
  return { address: token, topics: [TRANSFER, word(from), word(to)], data: amount(raw) };
}
function receipt(logs: ReturnType<typeof transferLog>[], status = 1) {
  return { status, logs, blockNumber: 100 };
}
const fast = { attempts: 2, delayMs: 0 };
const USDC_18 = 10n ** 12n; // native USDC has 18 decimals, the token 6

beforeEach(() => {
  for (const key of Object.keys(cfg)) delete cfg[key];
  Object.assign(cfg, {
    arcChainId: 5042002,
    arcRpcUrl: 'https://rpc.testnet.arc.io',
    arcEscrowAddress: '0xaBf70843E0380F1e749d2b85C30dD6820Ff5C731',
    arcUsdcAddress: USDC,
    deployFeeUsdcRaw: 1_000_000n,
  });
  chain.escrow = true;
  chain.treasury.mockReset().mockResolvedValue(TREASURY);
  chain.getTransactionReceipt.mockReset();
  // What a token transfer() looks like as a transaction: a call to the token, no value.
  chain.getTransaction.mockReset().mockResolvedValue({ from: OWNER, to: USDC, value: 0n });
  store.clear();
  _resetDeployFeeCache();
});

describe('arcDeployFeeTerms', () => {
  it("names Arc USDC, the escrow's treasury and the fee", async () => {
    expect(await arcDeployFeeTerms()).toEqual({
      method: 'transfer', chain: 'arc', token: USDC, recipient: TREASURY, amountRaw: '1000000', decimals: 6,
    });
  });

  it('is null on a stack with no Arc escrow', async () => {
    Object.assign(cfg, { arcEscrowAddress: '' });
    expect(await arcDeployFeeTerms()).toBeNull();
  });

  it('reads the treasury once and keeps it', async () => {
    await arcDeployFeeTerms();
    await arcDeployFeeTerms();
    expect(chain.treasury).toHaveBeenCalledTimes(1);
  });

  it('is 503, not a crash, when the treasury cannot be read and none was read before', async () => {
    chain.treasury.mockRejectedValueOnce(new Error('rpc down'));
    await expect(arcDeployFeeTerms()).rejects.toMatchObject({ statusCode: 503, code: 'DEPLOY_FEE_UNAVAILABLE' });
  });

  it('falls back to the last treasury read when a fresh read fails', async () => {
    vi.useFakeTimers();
    try {
      await arcDeployFeeTerms();
      vi.advanceTimersByTime(6 * 60_000); // past the cache's life
      chain.treasury.mockRejectedValueOnce(new Error('rpc down'));
      expect((await arcDeployFeeTerms())?.recipient).toBe(TREASURY);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('verifyArcDeployFee', () => {
  it("accepts 1 USDC from the deployer's wallet to the treasury", async () => {
    chain.getTransactionReceipt.mockResolvedValue(receipt([transferLog(OWNER, TREASURY, 1_000_000n)]));
    expect(await verifyArcDeployFee(TX, [OWNER], fast)).toEqual({ payer: OWNER.toLowerCase(), amountRaw: 1_000_000n });
  });

  it('matches wallets and the treasury whatever their letter case', async () => {
    chain.getTransactionReceipt.mockResolvedValue(receipt([transferLog(OWNER, TREASURY.toLowerCase(), 1_000_000n)]));
    await expect(verifyArcDeployFee(TX, [OWNER.toUpperCase().replace('0X', '0x')], fast)).resolves.toBeTruthy();
  });

  it('accepts more than the fee', async () => {
    chain.getTransactionReceipt.mockResolvedValue(receipt([transferLog(OWNER, TREASURY, 2_500_000n)]));
    expect((await verifyArcDeployFee(TX, [OWNER], fast)).amountRaw).toBe(2_500_000n);
  });

  it('finds the fee among other transfers in the same transaction', async () => {
    chain.getTransactionReceipt.mockResolvedValue(receipt([
      transferLog(OWNER, STRANGER, 5_000_000n),
      transferLog(OWNER, TREASURY, 1_000_000n),
    ]));
    await expect(verifyArcDeployFee(TX, [OWNER], fast)).resolves.toBeTruthy();
  });

  it('accepts the fee sent as native USDC, which leaves no log on the token', async () => {
    chain.getTransactionReceipt.mockResolvedValue(receipt([]));
    chain.getTransaction.mockResolvedValue({ from: OWNER, to: TREASURY, value: 1_000_000n * USDC_18 });
    expect(await verifyArcDeployFee(TX, [OWNER], fast)).toEqual({ payer: OWNER.toLowerCase(), amountRaw: 1_000_000n });
  });

  it('refuses a native send below the fee', async () => {
    chain.getTransactionReceipt.mockResolvedValue(receipt([]));
    chain.getTransaction.mockResolvedValue({ from: OWNER, to: TREASURY, value: 999_999n * USDC_18 });
    await expect(verifyArcDeployFee(TX, [OWNER], fast)).rejects.toMatchObject({ code: 'DEPLOY_FEE_NOT_PAID' });
  });

  it.each([
    ['less than the fee', transferLog(OWNER, TREASURY, 999_999n)],
    ['paid to someone else', transferLog(OWNER, STRANGER, 1_000_000n)],
    ['paid in another token', transferLog(OWNER, TREASURY, 1_000_000n, STRANGER)],
  ])('refuses a transfer %s', async (_label, log) => {
    chain.getTransactionReceipt.mockResolvedValue(receipt([log]));
    const err = await verifyArcDeployFee(TX, [OWNER], fast).catch((e) => e);
    expect(err).toMatchObject({ statusCode: 402, code: 'DEPLOY_FEE_NOT_PAID' });
    expect(err.reason).toBeUndefined();
  });

  it("says a fee paid from a wallet not on the caller's account is theirs to link, not a failed payment", async () => {
    chain.getTransactionReceipt.mockResolvedValue(receipt([transferLog(STRANGER, TREASURY, 1_000_000n)]));
    await expect(verifyArcDeployFee(TX, [OWNER], fast))
      .rejects.toMatchObject({ statusCode: 402, code: 'DEPLOY_FEE_NOT_PAID', reason: 'PAYER_NOT_LINKED' });
  });

  it('accepts a fee paid to the treasury of its day, after the treasury changed', async () => {
    chain.getTransactionReceipt.mockResolvedValue(receipt([transferLog(OWNER, OLD_TREASURY, 1_000_000n)]));
    chain.treasury.mockImplementation(async (overrides?: { blockTag?: number }) => (overrides?.blockTag === 100 ? OLD_TREASURY : TREASURY));
    await expect(verifyArcDeployFee(TX, [OWNER], fast)).resolves.toBeTruthy();
  });

  it('refuses a fee paid to an old treasury after it stopped being the treasury', async () => {
    chain.getTransactionReceipt.mockResolvedValue(receipt([transferLog(OWNER, OLD_TREASURY, 1_000_000n)]));
    await expect(verifyArcDeployFee(TX, [OWNER], fast)).rejects.toMatchObject({ code: 'DEPLOY_FEE_NOT_PAID' });
  });

  it("ignores a log that only looks like the token's Transfer", async () => {
    const approval = { ...transferLog(OWNER, TREASURY, 1_000_000n), topics: [ethers.id('Approval(address,address,uint256)'), word(OWNER), word(TREASURY)] };
    chain.getTransactionReceipt.mockResolvedValue(receipt([approval]));
    await expect(verifyArcDeployFee(TX, [OWNER], fast)).rejects.toMatchObject({ code: 'DEPLOY_FEE_NOT_PAID' });
  });

  it('refuses a transaction that reverted', async () => {
    chain.getTransactionReceipt.mockResolvedValue(receipt([], 0));
    await expect(verifyArcDeployFee(TX, [OWNER], fast)).rejects.toMatchObject({ statusCode: 402, code: 'DEPLOY_FEE_REVERTED' });
  });

  it('waits for a receipt the RPC does not have yet', async () => {
    chain.getTransactionReceipt
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('rpc hiccup'))
      .mockResolvedValue(receipt([transferLog(OWNER, TREASURY, 1_000_000n)]));
    await expect(verifyArcDeployFee(TX, [OWNER], { attempts: 3, delayMs: 0 })).resolves.toBeTruthy();
    expect(chain.getTransactionReceipt).toHaveBeenCalledTimes(3);
  });

  it('says so when the transaction is not confirmed', async () => {
    chain.getTransactionReceipt.mockResolvedValue(null);
    await expect(verifyArcDeployFee(TX, [OWNER], fast)).rejects.toMatchObject({ statusCode: 409, code: 'DEPLOY_FEE_NOT_FOUND' });
  });

  it('tells an unreachable RPC apart from an unconfirmed payment', async () => {
    chain.getTransactionReceipt.mockRejectedValue(new Error('ECONNRESET'));
    await expect(verifyArcDeployFee(TX, [OWNER], fast)).rejects.toMatchObject({ statusCode: 503, code: 'DEPLOY_FEE_CHECK_FAILED' });
  });

  it('does not wait on an RPC call that hangs', async () => {
    chain.getTransactionReceipt.mockReturnValue(new Promise(() => {}));
    await expect(verifyArcDeployFee(TX, [OWNER], { ...fast, timeoutMs: 20 })).rejects.toMatchObject({ code: 'DEPLOY_FEE_CHECK_FAILED' });
  });

  it('refuses when this stack takes no fee on Arc', async () => {
    Object.assign(cfg, { arcEscrowAddress: '' });
    await expect(verifyArcDeployFee(TX, [OWNER], fast)).rejects.toMatchObject({ code: 'DEPLOY_FEE_UNAVAILABLE' });
    expect(chain.getTransactionReceipt).not.toHaveBeenCalled();
  });
});

describe('the claim on a fee transaction', () => {
  it('lets one transaction pay for one deploy, whatever the hash case', async () => {
    expect(await claimArcDeployFee(TX, OWNER)).toEqual({ claimed: true });
    expect(await claimArcDeployFee(TX.toUpperCase().replace('0X', '0x'), OWNER)).toEqual({ claimed: false, pending: true });
  });

  it('names the agent a used transaction paid for', async () => {
    await claimArcDeployFee(TX, OWNER);
    await markArcDeployFeeUsed(TX, 'agent-1');
    expect(await claimArcDeployFee(TX, OWNER)).toEqual({ claimed: false, pending: false, agentId: 'agent-1' });
  });

  it('frees a transaction again once released', async () => {
    await claimArcDeployFee(TX, OWNER);
    await releaseArcDeployFee(TX);
    expect(await claimArcDeployFee(TX, OWNER)).toEqual({ claimed: true });
  });

  it('expires a claim whose deploy never finished, and keeps a used one', async () => {
    const { redis } = await import('./redis.js');
    await claimArcDeployFee(TX, OWNER);
    expect(vi.mocked(redis.set).mock.calls.at(-1)).toEqual([expect.any(String), `pending:${OWNER}`, 'EX', 600, 'NX']);
    await markArcDeployFeeUsed(TX, 'agent-1');
    expect(vi.mocked(redis.set).mock.calls.at(-1)).toEqual([expect.any(String), 'used:agent-1']);
  });
});
