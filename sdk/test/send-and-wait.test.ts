import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { sendAndWait, UnconfirmedTransactionError } from '../src/onchain.js';

/**
 * A local key's transaction is signed and its hash and nonce handed to
 * onSent before it is broadcast: a reply lost after the raw transaction left
 * cannot turn one that may land into "nothing was sent" (security review).
 * A wallet that signs out of reach (a browser extension) still sends in one step.
 */

const TO = '0x' + '5e'.repeat(20);

function localWallet(o: { broadcastFails?: boolean } = {}) {
  const order: string[] = [];
  const provider = {
    getNetwork: async () => new ethers.Network('arc', 5042002n),
    getTransactionCount: async () => 7,
    estimateGas: async () => 100_000n,
    getFeeData: async () => new ethers.FeeData(1_000_000_000n, 2_000_000_000n, 1_000_000_000n),
    broadcastTransaction: async (raw: string) => {
      order.push('broadcast');
      if (o.broadcastFails) throw new Error('socket hang up');
      return { hash: ethers.keccak256(raw), nonce: 7, wait: async () => ({ status: 1 }) };
    },
  };
  const wallet = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, provider as unknown as ethers.Provider);
  return { wallet, order };
}

describe('sendAndWait', () => {
  it('a local key: signs, hands the hash and nonce to onSent, then broadcasts', async () => {
    const { wallet, order } = localWallet();
    const seen: Array<[string, number, string | undefined]> = [];
    const res = await sendAndWait(wallet, { to: TO, data: '0x1234' }, {
      onSent: (hash, nonce, raw) => { order.push('onSent'); seen.push([hash, nonce, raw]); },
    });
    expect(order).toEqual(['onSent', 'broadcast']);
    expect(seen.map(([h, n]) => [h, n])).toEqual([[res.hash, 7]]);
    // The signed transaction itself, whose hash is the one recorded: safe to re-broadcast.
    expect(ethers.keccak256(seen[0][2]!)).toBe(res.hash);
    expect(ethers.Transaction.from(seen[0][2]!).nonce).toBe(7);
    expect(res.hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('a broadcast whose answer is lost is "may have been sent", with the hash already recorded', async () => {
    const { wallet } = localWallet({ broadcastFails: true });
    const seen: string[] = [];
    const err = await sendAndWait(wallet, { to: TO, data: '0x1234' }, {
      onSent: (hash) => { seen.push(hash); },
      unconfirmedHint: (hash) => `check ${hash} before sending again`,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(UnconfirmedTransactionError);
    expect(err.hash).toBe(seen[0]);
    expect(err.message).toContain('It may still land');
    expect(err.message).toContain(`check ${seen[0]}`);
  });

  it('a signer without a local key sends first, then reports the hash, as before', async () => {
    const order: string[] = [];
    const signer = {
      sendTransaction: async () => { order.push('send'); return { hash: '0x' + 'ab'.repeat(32), nonce: 3, wait: async () => ({ status: 1 }) }; },
    } as unknown as ethers.Signer;
    await sendAndWait(signer, { to: TO, data: '0x' }, { onSent: () => { order.push('onSent'); } });
    expect(order).toEqual(['send', 'onSent']);
  });
});
