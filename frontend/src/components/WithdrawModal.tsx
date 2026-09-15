import { useState } from 'react';
import { useSigners } from '@privy-io/react-auth';
import { parseUnits, formatUnits, Interface } from 'ethers';
import { Button, FormField, FormInput, Modal, Spinner } from './bb';
import { useWallet } from '../context/WalletContext';
import { useUsdcBalance } from '../hooks/useChainWallet';
import { signAndSendTx, RelayError } from '../lib/txSigner';
import { BASE_USDC_ADDRESS } from '../config/constants';

/**
 * Send USDC out of your BlindMarket (Privy-embedded) wallet to any address —
 * an external wallet, an exchange, wherever. Same gas-sponsored relay path
 * PostTask already uses for approve/createTask (backend/src/routes/tx.ts
 * only ever signs data-only calls from a wallet the caller owns), so this
 * needs no new backend endpoint: it's an ERC-20 transfer() built here and
 * handed to the relay like any other.
 *
 * RELAY_SIGNER_ID must match the signerId Settings.tsx's "Enable relay"
 * grants — both name the same registered Privy authorization key.
 */
const RELAY_SIGNER_ID = 'ed0tw7ng40gyfd6zu77cf0ol';

const ERC20_TRANSFER_ABI = ['function transfer(address to, uint256 amount) returns (bool)'];

type Phase = 'input' | 'confirm' | 'enabling-relay' | 'sending' | 'done' | 'error';

export function WithdrawModal({ onClose, onWithdrawn }: { onClose: () => void; onWithdrawn?: () => void }) {
  const { address, signer } = useWallet();
  const { addSigners } = useSigners();
  const usdc = useUsdcBalance();
  const balance = (usdc.raw as bigint | undefined) ?? null;

  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [phase, setPhase] = useState<Phase>('input');
  const [error, setError] = useState('');
  const [txHash, setTxHash] = useState<string | null>(null);
  const [needsRelay, setNeedsRelay] = useState(false);

  const toValid = /^0x[0-9a-fA-F]{40}$/.test(to.trim());

  let amountRaw: bigint | null = null;
  try {
    const v = parseUnits(amount || '0', 6);
    if (v > 0n) amountRaw = v;
  } catch { /* leave null */ }
  const exceedsBalance = balance !== null && amountRaw !== null && amountRaw > balance;

  async function handleEnableRelay() {
    if (!address) return;
    setPhase('enabling-relay');
    setError('');
    try {
      await addSigners({ address, signers: [{ signerId: RELAY_SIGNER_ID }] });
      setNeedsRelay(false);
      await doSend();
    } catch (err) {
      setError((err as Error).message || 'Could not enable relay access.');
      setPhase('confirm');
    }
  }

  async function doSend() {
    if (!signer || !amountRaw) return;
    setPhase('sending');
    setError('');
    try {
      const iface = new Interface(ERC20_TRANSFER_ABI);
      const data = iface.encodeFunctionData('transfer', [to.trim(), amountRaw]);
      const from = await signer.getAddress();
      const sent = await signAndSendTx(signer, { to: BASE_USDC_ADDRESS, data, from });
      setTxHash(sent.hash);
      setPhase('done');
      usdc.refresh();
      onWithdrawn?.();
    } catch (err) {
      if (err instanceof RelayError && err.code === 'PRIVY_AUTH_FAILED') {
        // The relay's authorization key isn't (yet) a co-signer on this
        // wallet — the one-time "Enable relay" grant hasn't happened for it.
        // Offer to do that right here instead of dead-ending on a raw 401.
        setNeedsRelay(true);
        setError('This wallet hasn\'t granted the platform relay access yet — needed once to sign gas-sponsored transactions.');
        setPhase('confirm');
        return;
      }
      setError((err as Error).message || 'Withdrawal failed.');
      setPhase('error');
    }
  }

  function handleReview() {
    setError('');
    if (!toValid) { setError('Enter a valid wallet address.'); return; }
    if (!amountRaw) { setError('Enter a valid USDC amount.'); return; }
    if (exceedsBalance) { setError('Exceeds your wallet balance.'); return; }
    setPhase('confirm');
  }

  const busy = phase === 'enabling-relay' || phase === 'sending';

  return (
    <Modal open onClose={onClose} dismissable={!busy} title="Withdraw" subtitle="Send USDC from your BlindMarket wallet" size="md">
      <>
        {phase === 'input' && (
          <div className="space-y-4">
            <FormField
              label="Your balance"
              hint={address ? undefined : 'Connect your wallet first.'}
            >
              <div className="px-3 py-2.5 bg-surface-2 border border-line text-sm font-mono text-ink">
                {balance === null ? 'Checking…' : `${parseFloat(formatUnits(balance, 6)).toFixed(4)} USDC`}
              </div>
            </FormField>
            <FormField label="Destination address">
              <FormInput
                type="text"
                placeholder="0x…"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </FormField>
            <FormField
              label="Amount (USDC)"
              hint={exceedsBalance ? 'Exceeds your wallet balance.' : undefined}
            >
              <div className="flex gap-2">
                <FormInput type="number" min="0" step="0.01" placeholder="10.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
                {balance !== null && balance > 0n && (
                  <Button
                    variant="ghost"
                    size="sm"
                    label="Use max"
                    className="shrink-0"
                    onClick={() => setAmount(formatUnits(balance, 6))}
                  />
                )}
              </div>
            </FormField>
            {error && <div className="text-xs text-err">{error}</div>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" label="Cancel" onClick={onClose} />
              <Button
                variant="primary"
                size="sm"
                label="Review withdrawal"
                onClick={handleReview}
                disabled={!address || !toValid || !amountRaw || exceedsBalance}
              />
            </div>
          </div>
        )}

        {phase === 'confirm' && (
          <div className="space-y-4">
            <div className="text-sm text-ink-2 border border-line bg-surface-2 p-4 space-y-1.5">
              <div>
                Send <span className="font-mono text-ink">{amount} USDC</span> to
              </div>
              <div className="font-mono text-xs text-ink break-all">{to.trim()}</div>
              <div className="text-xs text-ink-3 pt-1">This can't be undone. Double-check the address — there's no recovery for funds sent to the wrong one.</div>
            </div>
            {needsRelay && (
              <div className="text-xs text-warn border border-warn/40 bg-warn/5 p-3">
                One-time setup: this wallet needs to grant the platform relay access before it can sign gas-sponsored
                transactions. You'll be asked to approve this in your wallet.
              </div>
            )}
            {error && <div className="text-xs text-err">{error}</div>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" label="Back" onClick={() => setPhase('input')} />
              <Button
                variant="primary"
                size="sm"
                label={needsRelay ? 'Enable relay & send' : 'Confirm withdrawal'}
                onClick={needsRelay ? handleEnableRelay : doSend}
              />
            </div>
          </div>
        )}

        {busy && (
          <div className="py-8 text-center space-y-3">
            <div className="flex justify-center"><Spinner size={22} /></div>
            <div className="text-sm text-ink">{phase === 'enabling-relay' ? 'Enabling relay access…' : 'Sending…'}</div>
          </div>
        )}

        {phase === 'error' && (
          <div className="space-y-4">
            <div className="text-xs text-err">{error}</div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" label="Close" onClick={onClose} />
              <Button variant="primary" size="sm" label="Try again" onClick={() => setPhase('input')} />
            </div>
          </div>
        )}

        {phase === 'done' && (
          <div className="py-6 text-center space-y-3">
            <div className="text-sm text-ok">Withdrawal sent.</div>
            {txHash && <div className="font-mono text-xs text-ink-3">tx {txHash.slice(0, 10)}…</div>}
            <div className="flex justify-center pt-2">
              <Button variant="primary" size="sm" label="Done" onClick={onClose} />
            </div>
          </div>
        )}
      </>
    </Modal>
  );
}
