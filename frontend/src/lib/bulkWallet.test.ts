import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Interface, makeError } from 'ethers';

const signer = vi.hoisted(() => ({ signAndSendTx: vi.fn() }));
vi.mock('./txSigner', async (importOriginal) => ({ ...(await importOriginal<typeof import('./txSigner')>()), signAndSendTx: signer.signAndSendTx }));

const { NotSentError, TxRevertedError, bulkSigner, ensureTotalAllowance, gasLimitFor, sentNothing, waitForReceipt } = await import('./bulkWallet');
const { RelayError } = await import('./txSigner');
const { TxMismatchError } = await import('./bulkCalls');
const { getSettlement, defaultSettlement } = await import('../config/settlement');
const { pinnedContracts } = await import('./bulkCalls');
type CheckedCall = import('./bulkCalls').CheckedCall;

const HASH = `0x${'12'.repeat(32)}` as const;
const ME = '0x' + 'aa'.repeat(20);
const ERC20 = new Interface(['function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)']);
const BUILD = defaultSettlement().chains.arc;
const PINS = pinnedContracts('arc', { escrow: BUILD.escrow, token: BUILD.token.address });
/** A call as lib/bulkCalls hands it over (the signer never re-checks it). */
const call = (to: string, data: string, extra: Record<string, unknown> = {}) => ({ to, data, ...extra }) as unknown as CheckedCall;

beforeEach(() => signer.signAndSendTx.mockReset());

describe('waitForReceipt', () => {
  it('returns a mined receipt, riding out RPC hiccups', async () => {
    const getTransactionReceipt = vi.fn()
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ status: 1, blockNumber: 9 });
    expect(await waitForReceipt({ getTransactionReceipt } as never, HASH, { intervalMs: 0 })).toMatchObject({ blockNumber: 9 });
  });

  it('throws TxRevertedError for a reverted receipt (nothing was funded)', async () => {
    const wait = waitForReceipt({ getTransactionReceipt: async () => ({ status: 0 }) } as never, HASH, { intervalMs: 0 });
    await expect(wait).rejects.toBeInstanceOf(TxRevertedError);
    await expect(wait).rejects.toMatchObject({ code: 'TX_REVERTED', hash: HASH });
  });

  it('gives up with null (unconfirmed), never an error to retry', async () => {
    expect(await waitForReceipt({ getTransactionReceipt: async () => null } as never, HASH, { tries: 3, intervalMs: 0 })).toBeNull();
  });
});

describe('bulkSigner', () => {
  it("sends from the embedded wallet on Arc without Privy's per-transaction screen", async () => {
    const privySend = vi.fn(async () => ({ hash: HASH }));
    const order: string[] = [];
    const s = bulkSigner({
      chain: 'arc', from: ME, embeddedAddress: ME.toUpperCase().replace('0X', '0x'), privySend,
      getSigner: vi.fn(),
      provider: { estimateGas: async () => { order.push('estimate'); return 4_100_000n; }, getTransactionReceipt: async () => { order.push('wait'); return { status: 1 }; } } as never,
    });
    expect(s.headless).toBe(true);
    await s.send(call('0xescrow', '0xdata'), () => order.push('broadcast'));
    expect(privySend).toHaveBeenCalledWith(
      { to: '0xescrow', data: '0xdata', chainId: getSettlement().chains.arc.chainId, gasLimit: 4_920_000n },
      { uiOptions: { showWalletUIs: false }, address: expect.stringMatching(/^0x/i) },
    );
    expect(order).toEqual(['estimate', 'broadcast', 'wait']);
    expect(signer.signAndSendTx).not.toHaveBeenCalled();
  });

  it('keeps an external wallet on its own prompts', async () => {
    signer.signAndSendTx.mockResolvedValue({ hash: HASH, receipt: null });
    const onBroadcast = vi.fn();
    const s = bulkSigner({ chain: 'arc', from: ME, embeddedAddress: '0x' + 'bb'.repeat(20), privySend: vi.fn(), getSigner: async () => ({}) as never });
    expect(s.headless).toBe(false);
    expect(await s.send(call('0xe', '0x'), onBroadcast)).toEqual({ hash: HASH, receipt: null });
    expect(onBroadcast).toHaveBeenCalledWith(HASH);
    expect(signer.signAndSendTx).toHaveBeenCalledWith({}, { to: '0xe', data: '0x', from: ME }, undefined, { chain: 'arc' });
  });

  it("says an external wallet's reverted transaction reverted, and a signer that never came sent nothing", async () => {
    signer.signAndSendTx.mockRejectedValueOnce(new RelayError('TX_REVERTED', `Transaction ${HASH} reverted on-chain, so it had no effect (only its gas was spent).`));
    const s = bulkSigner({ chain: 'arc', from: ME, embeddedAddress: null, privySend: null, getSigner: async () => ({}) as never });
    const reverted = s.send(call('0xe', '0x'), () => {});
    await expect(reverted).rejects.toBeInstanceOf(TxRevertedError);
    await expect(reverted).rejects.toMatchObject({ hash: HASH });

    const noSigner = bulkSigner({ chain: 'arc', from: ME, embeddedAddress: null, privySend: null, getSigner: async () => { throw new Error('wallet locked'); } });
    await expect(noSigner.send(call('0xe', '0x'), () => {})).rejects.toBeInstanceOf(NotSentError);
    expect(signer.signAndSendTx).toHaveBeenCalledTimes(1);
  });

  it("passes on any other wallet failure as it is: it isn't known not to have sent", async () => {
    const dropped = new Error('socket hang up');
    signer.signAndSendTx.mockRejectedValueOnce(dropped);
    const s = bulkSigner({ chain: 'arc', from: ME, embeddedAddress: null, privySend: null, getSigner: async () => ({}) as never });
    await expect(s.send(call('0xe', '0x'), () => {})).rejects.toBe(dropped);
  });

  it('passes the wallet only the target and calldata, whatever else rides on the call', async () => {
    signer.signAndSendTx.mockResolvedValue({ hash: HASH, receipt: null });
    const s = bulkSigner({ chain: 'arc', from: ME, embeddedAddress: null, privySend: null, getSigner: async () => ({}) as never });
    await s.send(call('0xe', '0xab', { value: '5', gasLimit: 1 }), () => {});
    expect(signer.signAndSendTx).toHaveBeenCalledWith({}, { to: '0xe', data: '0xab', from: ME }, undefined, { chain: 'arc' });
  });

  it('uses the relay on a relayed chain, where nothing prompts', () => {
    const s = bulkSigner({ chain: 'base', from: ME, embeddedAddress: ME, privySend: vi.fn(), getSigner: vi.fn() });
    expect(s.headless).toBe(true);
  });
});

describe('ensureTotalAllowance', () => {
  const allowanceOf = (n: bigint) => ERC20.encodeFunctionResult('allowance', [n]);

  it('does nothing when the allowance already covers the run', async () => {
    const send = vi.fn();
    const call = vi.fn(async () => allowanceOf(10n));
    await ensureTotalAllowance({ signer: { send }, provider: { call } as never, pins: PINS, owner: ME, total: 10n });
    expect(send).not.toHaveBeenCalled();
    // The pinned token's allowance for the pinned escrow.
    expect(call).toHaveBeenCalledWith({ to: PINS.token, data: ERC20.encodeFunctionData('allowance', [ME, PINS.escrow]) });
  });

  it('approves the total once, to the pinned escrow on the pinned token, and waits until the chain shows it', async () => {
    const send = vi.fn(async () => ({ hash: HASH, receipt: null }));
    const call = vi.fn().mockResolvedValueOnce(allowanceOf(1n)).mockResolvedValueOnce(allowanceOf(1n)).mockResolvedValueOnce(allowanceOf(25n));
    await ensureTotalAllowance({ signer: { send }, provider: { call } as never, pins: PINS, owner: ME, total: 25n, waitMs: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    const [tx] = send.mock.calls[0] as unknown as [{ to: string; data: string }];
    // Checked, so only the target and calldata reach the wallet.
    expect(tx).toEqual({ to: PINS.token, data: ERC20.encodeFunctionData('approve', [PINS.escrow, 25n]) });
    const [spender, amount] = ERC20.decodeFunctionData('approve', tx.data);
    expect(String(spender).toLowerCase()).toBe(PINS.escrow.toLowerCase());
    expect(amount).toBe(25n);
  });

  it('asks to resume later when the approval never shows', async () => {
    await expect(ensureTotalAllowance({
      signer: { send: vi.fn(async () => ({ hash: HASH, receipt: null })) }, provider: { call: async () => allowanceOf(0n) } as never,
      pins: PINS, owner: ME, total: 5n, waitTries: 2, waitMs: 0,
    })).rejects.toMatchObject({ code: 'APPROVAL_PENDING' });
  });
});

describe('gasLimitFor', () => {
  it('never uses a gas limit the backend named: it estimates this transaction', async () => {
    const estimateGas = vi.fn(async () => 300_000n);
    expect(await gasLimitFor({ estimateGas } as never, { to: '0xe', data: '0x', gasLimit: 5_000_000 } as never, ME)).toBe(360_000n);
    expect(estimateGas).toHaveBeenCalledWith({ from: ME, to: '0xe', data: '0x' });
  });

  it("estimates this transaction and adds 20%, so a batch never reuses one task's limit", async () => {
    const estimateGas = vi.fn(async () => 1_000_000n);
    expect(await gasLimitFor({ estimateGas } as never, { to: '0xe', data: '0xbatch' }, ME)).toBe(1_200_000n);
    expect(estimateGas).toHaveBeenCalledWith({ from: ME, to: '0xe', data: '0xbatch' });
  });

  it("sends headless with this app's own estimate, not a gas limit or value smuggled onto the call", async () => {
    const privySend = vi.fn(async () => ({ hash: HASH }));
    const estimateGas = vi.fn(async () => 2_000_000n);
    const s = bulkSigner({
      chain: 'arc', from: ME, embeddedAddress: ME, privySend, getSigner: vi.fn(),
      provider: { estimateGas, getTransactionReceipt: async () => ({ status: 1 }) } as never,
    });
    await s.send(call('0xe', '0xab', { gasLimit: 21_000, value: '7' }), () => {});
    expect(estimateGas).toHaveBeenCalledWith({ from: ME, to: '0xe', data: '0xab' });
    expect(privySend).toHaveBeenCalledWith(
      { to: '0xe', data: '0xab', chainId: getSettlement().chains.arc.chainId, gasLimit: 2_400_000n },
      { uiOptions: { showWalletUIs: false }, address: ME },
    );
  });

  it('refuses to send when the estimate reverts: the transaction would fail', async () => {
    const privySend = vi.fn();
    const s = bulkSigner({
      chain: 'arc', from: ME, embeddedAddress: ME, privySend, getSigner: vi.fn(),
      provider: { estimateGas: async () => { throw new Error('execution reverted: ERC20InsufficientAllowance'); }, getTransactionReceipt: vi.fn() } as never,
    });
    const onBroadcast = vi.fn();
    const sending = s.send(call('0xe', '0x'), onBroadcast);
    await expect(sending).rejects.toThrow('InsufficientAllowance');
    await expect(sending).rejects.toBeInstanceOf(NotSentError);
    expect(privySend).not.toHaveBeenCalled();
    expect(onBroadcast).not.toHaveBeenCalled();
  });
});

describe('sentNothing', () => {
  it('holds for failures that come before a broadcast, or from a revert', () => {
    for (const e of [
      makeError('user rejected action', 'ACTION_REJECTED'),
      Object.assign(new Error('User rejected the request.'), { code: 4001 }),
      Object.assign(new Error('rejected'), { name: 'UserRejectedRequestError' }),
      makeError('insufficient funds for intrinsic transaction cost', 'INSUFFICIENT_FUNDS'),
      new RelayError('WRONG_CHAIN', 'Your wallet is on chain 1, not arc (5042).'),
      makeError('execution reverted', 'CALL_EXCEPTION', { action: 'estimateGas', data: null, reason: null, transaction: { to: null, data: '0x' }, invocation: null, revert: null }),
      new TxRevertedError(HASH),
      new NotSentError(new Error('could not estimate gas')),
      new TxMismatchError('sent to 0x…'),
    ]) {
      expect(sentNothing(e)).toBe(true);
    }
  });

  it('does not hold for anything that could follow a broadcast', () => {
    for (const e of [
      new Error('socket hang up'),
      // Reads as a wrong-chain error by its text, but ethers throws it after broadcasting too.
      makeError('network changed', 'NETWORK_ERROR'),
      Object.assign(new Error('Transaction failed'), { privyErrorCode: 'transaction_failure' }),
      new RelayError('RELAY_FAILED', 'Relay failed (502)'),
      undefined,
    ]) {
      expect(sentNothing(e)).toBe(false);
    }
  });
});
