import { useRef, useState } from 'react';
import { useSigners } from '@privy-io/react-auth';
import { parseUnits, formatUnits, Interface, isAddress, getAddress, ZeroAddress } from 'ethers';
import { Button, FormField, FormInput, Modal, Spinner } from './bb';
import { useWallet } from '../context/WalletContext';
import { useUsdcBalance } from '../hooks/useChainWallet';
import { signAndSendTx, RelayError, type SentTx } from '../lib/txSigner';
import { BASE_USDC_ADDRESS, BASE_ESCROW_ADDRESS, BASE_CHAIN_CONFIG, PRIVY_RELAY_SIGNER_ID } from '../config/constants';

const ERC20_TRANSFER_ABI = ['function transfer(address to, uint256 amount) returns (bool)'];
// Kept back because user-pays gas is charged in USDC from this same wallet.
const USDC_GAS_RESERVE_RAW = 50_000n;
const NETWORK = BASE_CHAIN_CONFIG.chainName;

type Phase = 'input' | 'confirm' | 'enabling-relay' | 'sending' | 'done' | 'pending' | 'error';

function destinationError(value: string, self: string | null): string | null {
  if (!isAddress(value)) return 'Not a valid address — check it for typos.';
  const a = getAddress(value);
  if (a === ZeroAddress) return "Can't send to the zero address.";
  if (a === getAddress(BASE_USDC_ADDRESS)) return "That's the USDC token contract — funds sent there are lost.";
  if (BASE_ESCROW_ADDRESS && a === getAddress(BASE_ESCROW_ADDRESS)) return "That's the BlindMarket escrow contract — send to a wallet instead.";
  if (self && a === getAddress(self)) return "That's your BlindMarket wallet itself.";
  return null;
}

/** Sends USDC out of the user's embedded wallet through the gas-sponsored relay (backend routes/tx.ts). */
export function WithdrawModal({ onClose, onWithdrawn }: { onClose: () => void; onWithdrawn?: () => void }) {
  const { signer, embeddedAddress, externalAddresses } = useWallet();
  const { addSigners } = useSigners();
  const usdc = useUsdcBalance(embeddedAddress);
  const balance = (usdc.raw as bigint | undefined) ?? null;

  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [phase, setPhase] = useState<Phase>('input');
  const [error, setError] = useState('');
  const [txHash, setTxHash] = useState<string | null>(null);
  const [needsRelay, setNeedsRelay] = useState(false);
  const relayGrantTried = useRef(false);

  const destination = to.trim();
  const destError = destination ? destinationError(destination, embeddedAddress) : null;

  let amountRaw: bigint | null = null;
  try {
    const v = parseUnits(amount || '0', 6);
    if (v > 0n) amountRaw = v;
  } catch { /* leave null */ }
  const amountInvalid = amount.trim() !== '' && amountRaw === null;
  const spendable = balance === null ? null : balance > USDC_GAS_RESERVE_RAW ? balance - USDC_GAS_RESERVE_RAW : 0n;
  const exceedsBalance = spendable !== null && amountRaw !== null && amountRaw > spendable;
  const canReview = !!embeddedAddress && !!destination && !destError && amountRaw !== null && !exceedsBalance;

  async function handleEnableRelay() {
    if (!embeddedAddress) return;
    relayGrantTried.current = true;
    setPhase('enabling-relay');
    setError('');
    try {
      await addSigners({ address: embeddedAddress, signers: [{ signerId: PRIVY_RELAY_SIGNER_ID }] });
    } catch (err) {
      setError((err as Error).message || 'Could not enable relay access.');
      setPhase('confirm');
      return;
    }
    setNeedsRelay(false);
    await doSend();
  }

  async function doSend() {
    setError('');
    if (!signer || !embeddedAddress || amountRaw === null) {
      setError('Your wallet is still loading — try again in a moment.');
      setPhase('confirm');
      return;
    }
    setPhase('sending');
    let sent: SentTx;
    try {
      const from = await signer.getAddress();
      if (from.toLowerCase() !== embeddedAddress.toLowerCase()) {
        setError('Your BlindMarket wallet is still connecting — try again in a moment.');
        setPhase('confirm');
        return;
      }
      const data = new Interface(ERC20_TRANSFER_ABI).encodeFunctionData('transfer', [getAddress(destination), amountRaw]);
      sent = await signAndSendTx(signer, { to: BASE_USDC_ADDRESS, data, from });
    } catch (err) {
      if (err instanceof RelayError && err.code === 'PRIVY_AUTH_FAILED') {
        // The backend uses this code for any Privy 401/403 — only offer the grant once.
        if (relayGrantTried.current) {
          setError("The relay still can't sign for this wallet after access was enabled. That points to a server-side problem, not your wallet — please contact support.");
          setPhase('error');
        } else {
          setNeedsRelay(true);
          setPhase('confirm');
        }
        return;
      }
      setError(err instanceof RelayError
        ? err.message || 'Withdrawal failed.'
        : `${(err as Error).message || 'Withdrawal failed.'} We couldn't confirm whether it was sent — check your balance before trying again.`);
      setPhase('error');
      return;
    }

    setTxHash(sent.hash);
    if (sent.receipt && sent.receipt.status !== 1) {
      setError('The transfer reverted on-chain — no USDC left your wallet.');
      setPhase('error');
      return;
    }
    setPhase(sent.receipt ? 'done' : 'pending');
    onWithdrawn?.();
  }

  const busy = phase === 'enabling-relay' || phase === 'sending';

  return (
    <Modal open onClose={onClose} dismissable={!busy} title="Withdraw" subtitle={`USDC on ${NETWORK}`} size="md">
      <>
        {phase === 'input' && (
          <div className="space-y-4">
            <FormField
              label="Your BlindMarket wallet"
              hint={embeddedAddress ? `${formatUnits(USDC_GAS_RESERVE_RAW, 6)} USDC stays behind to cover the network fee.` : 'Your BlindMarket wallet hasn\'t loaded yet.'}
            >
              <div className="px-3 py-2.5 bg-surface-2 border border-line text-sm font-mono text-ink">
                {!embeddedAddress ? '—' : balance === null ? 'Checking…' : `${parseFloat(formatUnits(balance, 6)).toFixed(4)} USDC`}
              </div>
            </FormField>
            <FormField label={`Destination address (${NETWORK})`} hint={destError ?? undefined}>
              <FormInput type="text" placeholder="0x…" className="font-mono" value={to} onChange={(e) => setTo(e.target.value)} />
              {externalAddresses.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {externalAddresses.map((a) => (
                    <Button
                      key={a}
                      variant="ghost"
                      size="sm"
                      label={`Send to my linked wallet (${a.slice(0, 6)}…${a.slice(-4)})`}
                      onClick={() => setTo(a)}
                    />
                  ))}
                </div>
              )}
            </FormField>
            <FormField
              label="Amount (USDC)"
              hint={
                amountInvalid ? 'Enter a valid amount (up to 6 decimals).'
                : exceedsBalance ? `More than you can send — max ${formatUnits(spendable ?? 0n, 6)} USDC after the network-fee reserve.`
                : undefined
              }
            >
              <div className="flex gap-2">
                <FormInput type="number" min="0" step="0.01" placeholder="10.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
                {spendable !== null && spendable > 0n && (
                  <Button variant="ghost" size="sm" label="Use max" className="shrink-0" onClick={() => setAmount(formatUnits(spendable, 6))} />
                )}
              </div>
            </FormField>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" label="Cancel" onClick={onClose} />
              <Button variant="primary" size="sm" label="Review withdrawal" onClick={() => { setError(''); setPhase('confirm'); }} disabled={!canReview} />
            </div>
          </div>
        )}

        {phase === 'confirm' && (
          <div className="space-y-4">
            <div className="text-sm text-ink-2 border border-line bg-surface-2 p-4 space-y-1.5">
              <div>
                Send <span className="font-mono text-ink">{amountRaw !== null ? formatUnits(amountRaw, 6) : amount} USDC</span> on{' '}
                <span className="text-ink">{NETWORK}</span> to
              </div>
              <div className="font-mono text-xs text-ink break-all">{destError ? destination : getAddress(destination)}</div>
              <div className="text-xs text-ink-3 pt-1">
                Only send to an address that accepts USDC on {NETWORK} — many exchange deposit addresses work on a
                single network only. This can't be undone.
              </div>
            </div>
            {needsRelay && (
              <div className="text-xs text-warn border border-warn/40 bg-warn/5 p-3">
                One-time setup: this wallet needs to grant the platform relay access before it can sign gas-sponsored
                transactions. You'll be asked to approve this in your wallet.
              </div>
            )}
            {error && <div className="text-xs text-err">{error}</div>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" label="Back" onClick={() => { setError(''); setPhase('input'); }} />
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
            <div className="text-sm text-ink">
              {phase === 'enabling-relay' ? 'Approve relay access in your wallet…' : 'Sending and waiting for confirmation…'}
            </div>
            <div className="text-xs text-ink-3">Don't close this window.</div>
          </div>
        )}

        {phase === 'error' && (
          <div className="space-y-4">
            <div className="text-xs text-err">{error}</div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" label="Close" onClick={onClose} />
              <Button variant="primary" size="sm" label="Try again" onClick={() => { setError(''); setPhase('input'); }} />
            </div>
          </div>
        )}

        {phase === 'done' && (
          <div className="py-6 text-center space-y-3">
            <div className="text-sm text-ok">Withdrawal confirmed on {NETWORK}.</div>
            {txHash && <div className="font-mono text-xs text-ink-3">tx {txHash.slice(0, 10)}…</div>}
            <div className="flex justify-center pt-2">
              <Button variant="primary" size="sm" label="Done" onClick={onClose} />
            </div>
          </div>
        )}

        {phase === 'pending' && (
          <div className="py-6 text-center space-y-3">
            <div className="text-sm text-ink">Withdrawal submitted — not confirmed yet.</div>
            <div className="text-xs text-ink-3">
              It can take a few minutes to land. Don't send it again — check your balance shortly.
            </div>
            {txHash && <div className="font-mono text-xs text-ink-3">ref {txHash.slice(0, 10)}…</div>}
            <div className="flex justify-center pt-2">
              <Button variant="primary" size="sm" label="Done" onClick={onClose} />
            </div>
          </div>
        )}
      </>
    </Modal>
  );
}
