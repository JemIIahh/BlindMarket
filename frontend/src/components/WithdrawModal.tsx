import { useEffect, useRef, useState } from 'react';
import { useSigners } from '@privy-io/react-auth';
import { parseUnits, formatUnits, Interface, isAddress, getAddress, ZeroAddress, Contract, EventLog, type JsonRpcProvider } from 'ethers';
import { Button, ErrorNotice, FormField, FormInput, Modal, Spinner } from './bb';
import { useWallet } from '../context/WalletContext';
import { useUsdcBalance } from '../hooks/useChainWallet';
import { signAndSendTx, RelayError, providerFor, type SentTx } from '../lib/txSigner';
import { UserFacingError, friendlyError } from '../lib/friendlyError';
import { PRIVY_RELAY_SIGNER_ID } from '../config/constants';
import { useSettlement } from '../config/settlement';

const ERC20_TRANSFER_ABI = ['function transfer(address to, uint256 amount) returns (bool)'];
const TRANSFER_EVENT_ABI = ['event Transfer(address indexed from, address indexed to, uint256 value)'];
// Kept back because user-pays gas is charged in USDC from this same wallet.
const USDC_GAS_RESERVE_RAW = 50_000n;

type Phase = 'input' | 'confirm' | 'enabling-relay' | 'sending' | 'confirming' | 'done' | 'pending' | 'error';

/** Polls the settlement chain (~2 min) for the USDC Transfer this withdrawal emits; returns its tx hash. */
async function waitForTransfer(
  from: string, to: string, value: bigint, fromBlock: number, cancelled: () => boolean,
  usdcAddress: string, provider: JsonRpcProvider,
): Promise<string | null> {
  const usdc = new Contract(usdcAddress, TRANSFER_EVENT_ABI, provider);
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    if (cancelled()) return null;
    try {
      const logs = await usdc.queryFilter(usdc.filters.Transfer(from, to), fromBlock);
      const hit = logs.find((l): l is EventLog => l instanceof EventLog && l.args.value === value);
      if (hit) return hit.transactionHash;
    } catch { /* transient RPC error — keep polling */ }
  }
  return null;
}

function destinationError(value: string, self: string | null, usdcAddress: string, escrowAddress: string): string | null {
  if (!isAddress(value)) return 'Not a valid address — check it for typos.';
  const a = getAddress(value);
  if (a === ZeroAddress) return "Can't send to the zero address.";
  if (a === getAddress(usdcAddress)) return "That's the USDC token contract — funds sent there are lost.";
  if (escrowAddress && a === getAddress(escrowAddress)) return "That's the BlindMarket escrow contract — send to a wallet instead.";
  if (self && a === getAddress(self)) return "That's your BlindMarket wallet itself.";
  return null;
}

/** Sends USDC out of the user's embedded wallet through the gas-sponsored relay (backend routes/tx.ts). */
export function WithdrawModal({ onClose, onWithdrawn }: { onClose: () => void; onWithdrawn?: () => void }) {
  const { signer, embeddedAddress, externalAddresses } = useWallet();
  const { addSigners } = useSigners();
  const usdc = useUsdcBalance(embeddedAddress);
  const balance = (usdc.raw as bigint | undefined) ?? null;

  // The settlement chain (Arc now): withdraw its USDC, not Base's.
  const settlement = useSettlement();
  const posting = settlement.chains[settlement.postingChain];
  const usdcAddress = posting.token.address;
  const escrowAddress = posting.escrow;
  const networkName = posting.label;
  const postingKey = settlement.postingChain;

  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [phase, setPhase] = useState<Phase>('input');
  const [error, setError] = useState<unknown>('');
  const [txHash, setTxHash] = useState<string | null>(null);
  const [needsRelay, setNeedsRelay] = useState(false);
  const relayGrantTried = useRef(false);
  // Reset on mount too: StrictMode's mount→unmount→mount would otherwise leave it true.
  const closedRef = useRef(false);
  useEffect(() => {
    closedRef.current = false;
    return () => { closedRef.current = true; };
  }, []);

  const destination = to.trim();
  const destError = destination ? destinationError(destination, embeddedAddress, usdcAddress, escrowAddress) : null;

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
      setError(err);
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
    const dest = getAddress(destination);
    const provider = providerFor(postingKey);
    const startBlock = await provider.getBlockNumber().catch(() => null);
    let sent: SentTx;
    try {
      const from = await signer.getAddress();
      if (from.toLowerCase() !== embeddedAddress.toLowerCase()) {
        setError('Your BlindMarket wallet is still connecting — try again in a moment.');
        setPhase('confirm');
        return;
      }
      const data = new Interface(ERC20_TRANSFER_ABI).encodeFunctionData('transfer', [dest, amountRaw]);
      // The settlement chain's USDC transfer (Arc signs directly; Base relays).
      sent = await signAndSendTx(signer, { to: usdcAddress, data, from }, undefined, { chain: postingKey });
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
      const f = friendlyError(err);
      // The wallet broadcast it before the wait failed: it is on its way, or
      // gone for good, but either way sending again could pay twice.
      if (f.kind === 'maybeSent') {
        if (f.txHash) setTxHash(f.txHash);
        setPhase('pending');
        onWithdrawn?.();
        return;
      }
      // A cancel, a shortfall, a wrong network or a refused call sent nothing;
      // anything else may have gone out before it failed.
      const known = f.kind;
      setError(err instanceof RelayError || ['cancelled', 'funds', 'chain', 'revert'].includes(known)
        ? err
        : new UserFacingError("We couldn't confirm whether it was sent. Check your balance before trying again.", { title: 'Withdrawal status unknown', cause: err }));
      setPhase('error');
      return;
    }

    setTxHash(sent.hash);
    if (sent.receipt) {
      if (sent.receipt.status !== 1) {
        setError('The transfer reverted on-chain — no USDC left your wallet.');
        setPhase('error');
        return;
      }
      setPhase('done');
      onWithdrawn?.();
      return;
    }

    // Sponsored sends come back as user-ops with no tx hash, so confirm from the Transfer event.
    setPhase('confirming');
    const landedTx = startBlock === null
      ? null
      : await waitForTransfer(embeddedAddress, dest, amountRaw, Math.max(0, startBlock - 2), () => closedRef.current, usdcAddress, provider);
    if (closedRef.current) return;
    if (landedTx) setTxHash(landedTx);
    setPhase(landedTx ? 'done' : 'pending');
    onWithdrawn?.();
  }

  const busy = phase === 'enabling-relay' || phase === 'sending';

  return (
    <Modal open onClose={onClose} dismissable={!busy} title="Withdraw" subtitle={`USDC on ${networkName}`} size="md">
      <>
        {phase === 'input' && (
          <div className="space-y-4">
            <FormField
              label="Your BlindMarket wallet"
              hint={embeddedAddress ? `${formatUnits(USDC_GAS_RESERVE_RAW, 6)} USDC stays behind to cover the network fee.` : 'Your BlindMarket wallet hasn\'t loaded yet.'}
            >
              <div className="rounded-xl border border-line bg-surface-2 px-3.5 py-2.5 text-sm font-mono text-ink">
                {!embeddedAddress ? '—' : balance === null ? 'Checking…' : `${parseFloat(formatUnits(balance, 6)).toFixed(4)} USDC`}
              </div>
            </FormField>
            <FormField label={`Destination address (${networkName})`} hint={destError ?? undefined}>
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
            <div className="rounded-2xl border border-line bg-surface-2 p-4 text-sm text-ink-2 space-y-1.5">
              <div>
                Send <span className="font-mono text-ink">{amountRaw !== null ? formatUnits(amountRaw, 6) : amount} USDC</span> on{' '}
                <span className="text-ink">{networkName}</span> to
              </div>
              <div className="font-mono text-xs text-ink break-all">{destError ? destination : getAddress(destination)}</div>
              <div className="text-xs text-ink-3 pt-1">
                Only send to an address that accepts USDC on {networkName} — many exchange deposit addresses work on a
                single network only. This can't be undone.
              </div>
            </div>
            {needsRelay && (
              <div className="rounded-xl border border-[color:color-mix(in_srgb,var(--bb-warn)_45%,transparent)] bg-[color:color-mix(in_srgb,var(--bb-warn)_6%,transparent)] p-3 text-xs text-ink-2 leading-relaxed">
                One-time setup: this wallet needs to grant the platform relay access before it can sign gas-sponsored
                transactions. You'll be asked to approve this in your wallet.
              </div>
            )}
            <ErrorNotice error={error} title="Couldn't withdraw" />
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

        {phase === 'confirming' && (
          <div className="py-8 text-center space-y-3">
            <div className="flex justify-center"><Spinner size={22} /></div>
            <div className="text-sm text-ink">Sent — waiting for it to land on {networkName}…</div>
            <div className="text-xs text-ink-3">Usually a few seconds. It's already submitted, so closing this won't cancel it.</div>
          </div>
        )}

        {phase === 'error' && (
          <div className="space-y-4">
            <ErrorNotice error={error} title="Couldn't withdraw" />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" label="Close" onClick={onClose} />
              <Button variant="primary" size="sm" label="Try again" onClick={() => { setError(''); setPhase('input'); }} />
            </div>
          </div>
        )}

        {phase === 'done' && (
          <div className="py-6 text-center space-y-3">
            <div className="text-sm text-ok">Withdrawal confirmed on {networkName}.</div>
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
