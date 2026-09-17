import { useState, useEffect, useRef } from 'react';
import { useWallets, usePrivy } from '@privy-io/react-auth';
import { parseUnits, formatUnits, JsonRpcProvider, Contract } from 'ethers';
import { Button, FormField, FormInput, FormSelect, Modal, Spinner } from './bb';
import { get, authedPost, authedGet } from '../lib/api';
import { useWallet, switchWalletToChain, type AddEthereumChainParameter } from '../context/WalletContext';
import { signAndSendDirect } from '../lib/directSigner';
import { BASE_CCTP_CHAIN_KEY, isCctpUsable } from '../config/constants';

/**
 * CCTP Phase B (inbound) — fund the user's Base wallet from USDC held on
 * another chain, via Circle's CCTP V2 burn-and-mint. The backend only ever
 * builds unsigned calldata for this direction (routes/cctp.ts); the actual
 * burn is signed here, directly, by the user's own EXTERNAL wallet — the
 * Privy EMBEDDED (Base) wallet is the mint recipient, never the signer, since
 * it isn't set up to hold/sign on arbitrary other chains.
 */

// EIP-3085 configs for the non-Base CCTP source chains this UI offers. (Only
// what's needed for `wallet_addEthereumChain` — the backend's
// /api/v1/cctp/config remains the source of truth for domain/contract/usdc
// addresses actually used in the transfer itself.) Must also be listed in
// Privy's `supportedChains` (App.tsx) or `switchWalletToChain` fails with
// "Unsupported chainId" before ever reaching the wallet.
const SOURCE_CHAIN_WALLET_CONFIG: Record<string, AddEthereumChainParameter> = {
  ethereum: {
    chainId: '0x1',
    chainName: 'Ethereum',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://ethereum-rpc.publicnode.com'],
    blockExplorerUrls: ['https://etherscan.io'],
  },
  'ethereum-sepolia': {
    chainId: '0xaa36a7',
    chainName: 'Ethereum Sepolia',
    nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com'],
    blockExplorerUrls: ['https://sepolia.etherscan.io'],
  },
  arbitrum: {
    chainId: '0xa4b1',
    chainName: 'Arbitrum',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://arb1.arbitrum.io/rpc'],
    blockExplorerUrls: ['https://arbiscan.io'],
  },
  'arbitrum-sepolia': {
    chainId: '0x66eee',
    chainName: 'Arbitrum Sepolia',
    nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://sepolia-rollup.arbitrum.io/rpc'],
    blockExplorerUrls: ['https://sepolia.arbiscan.io'],
  },
  optimism: {
    chainId: '0xa',
    chainName: 'Optimism',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://mainnet.optimism.io'],
    blockExplorerUrls: ['https://optimistic.etherscan.io'],
  },
  'optimism-sepolia': {
    chainId: '0xaa37dc',
    chainName: 'Optimism Sepolia',
    nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://sepolia.optimism.io'],
    blockExplorerUrls: ['https://sepolia-optimism.etherscan.io'],
  },
  // Arc's gas token IS USDC (18-dec native view of the same balance whose
  // ERC-20 view is 6-dec) — hence the backend's usdcGasReserveRaw below.
  'arc-testnet': {
    chainId: '0x4cef52',
    chainName: 'Arc Testnet',
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpcUrls: ['https://rpc.testnet.arc.io'],
    blockExplorerUrls: ['https://testnet.arcscan.app'],
  },
};

// Source-chain gas check — a FLOOR, not an estimate: the burn alone uses
// ~105–126k gas (measured on Base Sepolia / Arc testnet), the approve adds
// ~45–55k, and Arbitrum adds its L1 data cost on top. A wallet below
// gasPrice × this floor can't possibly pay, so Bridge is blocked; above it the
// wallet has the final say. (Arc pays gas in USDC — covered by the reserve.)
const SOURCE_GAS_FLOOR_UNITS = 100_000n;

type Phase = 'input' | 'switching' | 'approving' | 'burning' | 'confirming' | 'polling' | 'done' | 'error';

interface CctpChainOption {
  chainKey: string;
  chainId: number;
  usdcAddress: string;
  label: string;
  isTestnet?: boolean;
  /** USDC (6-dec raw) to leave on this chain for gas — non-zero only where
   *  gas is paid in USDC (Arc). Same number /deposit-intent enforces. */
  usdcGasReserveRaw?: string;
}

export function CctpFundModal({ onClose, onFunded }: { onClose: () => void; onFunded?: () => void }) {
  const { address: baseAddress } = useWallet();
  const { wallets } = useWallets();
  const { connectWallet } = usePrivy();

  const [chains, setChains] = useState<CctpChainOption[]>([]);
  const [sourceChain, setSourceChain] = useState('');
  const [amount, setAmount] = useState('');
  const [phase, setPhase] = useState<Phase>('input');
  const [error, setError] = useState('');
  const [transferId, setTransferId] = useState<number | null>(null);
  const [mintTxHash, setMintTxHash] = useState<string | null>(null);
  // Preview state — both shown BEFORE the user commits to a chain switch +
  // signature, not only discoverable afterward.
  const [sourceBalance, setSourceBalance] = useState<bigint | null>(null);
  // Native gas balance + gas price on an ETH-gas source chain (null = unknown,
  // or a USDC-gas chain like Arc where the reserve covers gas instead).
  const [sourceGas, setSourceGas] = useState<{ balance: bigint; gasPrice: bigint | null } | null>(null);
  const [quote, setQuote] = useState<{ maxFeeRaw: string; estimatedReceiveRaw: string } | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);

  const abortedRef = useRef(false);
  // Reset on mount, not just set on unmount: StrictMode (dev) mounts,
  // unmounts, then remounts every component, and a cleanup-only effect left
  // this stuck at true — pollTransfer then quit on its first tick and the
  // modal sat on "Circle is minting…" forever though the mint had landed.
  useEffect(() => {
    abortedRef.current = false;
    return () => { abortedRef.current = true; };
  }, []);

  useEffect(() => {
    get<{ enabled: boolean; baseChainId?: number | null; chains: CctpChainOption[] }>('/api/v1/cctp/config')
      .then((data) => {
        if (!isCctpUsable(data)) return;
        // Only chains this build can actually switch a wallet to — the
        // backend can list a chain before this bundle knows it (a deploy
        // skew, or a tab left open across one).
        const sources = data.chains.filter((c) => !c.chainKey.startsWith('base') && SOURCE_CHAIN_WALLET_CONFIG[c.chainKey]);
        setChains(sources);
        if (sources.length > 0) setSourceChain((prev) => prev || sources[0].chainKey);
      })
      .catch(() => setError('Could not load supported chains.'));
  }, []);

  // The embedded (Privy-managed) wallet funds tasks on Base — it's never the
  // signer here. Any OTHER linked wallet is a candidate to sign the burn.
  const externalWallet = wallets.find((w) => w.walletClientType !== 'privy') ?? null;

  const busy = phase === 'switching' || phase === 'approving' || phase === 'burning' || phase === 'confirming' || phase === 'polling';

  // Live balance on the chosen source chain — a direct read against a public
  // RPC, no wallet interaction (and no chain switch) needed just to read it.
  // Lets the amount field be validated against what the user actually holds
  // BEFORE they go through switching chains and signing.
  useEffect(() => {
    const chain = chains.find((c) => c.chainKey === sourceChain);
    const rpcUrl = SOURCE_CHAIN_WALLET_CONFIG[sourceChain]?.rpcUrls[0];
    if (!chain || !rpcUrl || !externalWallet) { setSourceBalance(null); setSourceGas(null); return; }
    let cancelled = false;
    setSourceBalance(null);
    setSourceGas(null);
    const usdcGasChain = BigInt(chain.usdcGasReserveRaw ?? '0') > 0n;
    (async () => {
      const provider = new JsonRpcProvider(rpcUrl);
      // Native gas read is independent of the USDC read: if it fails, the
      // check stays unknown (never blocks) instead of hiding the balance.
      const gasRead = usdcGasChain ? Promise.resolve(null) : (async () => {
        try {
          const [balance, gasPriceHex] = await Promise.all([
            provider.getBalance(externalWallet.address),
            provider.send('eth_gasPrice', []).catch(() => null) as Promise<string | null>,
          ]);
          return { balance, gasPrice: gasPriceHex ? BigInt(gasPriceHex) : null };
        } catch {
          return null;
        }
      })();
      try {
        const usdc = new Contract(chain.usdcAddress, ['function balanceOf(address) view returns (uint256)'], provider);
        const bal: bigint = await usdc.balanceOf(externalWallet.address);
        if (!cancelled) setSourceBalance(bal);
      } catch {
        if (!cancelled) setSourceBalance(null);
      }
      const gas = await gasRead;
      if (!cancelled) setSourceGas(gas);
    })();
    return () => { cancelled = true; };
  }, [sourceChain, externalWallet?.address, chains]);

  // Fee preview — GET /api/v1/cctp/quote, debounced (400ms) since it fires
  // on every keystroke in the amount field.
  useEffect(() => {
    let amountRaw: bigint;
    try {
      amountRaw = parseUnits(amount || '0', 6);
      if (amountRaw <= 0n) throw new Error();
    } catch {
      setQuote(null);
      return;
    }
    if (!sourceChain) { setQuote(null); return; }
    let cancelled = false;
    setQuoteLoading(true);
    const t = setTimeout(() => {
      get<{ maxFeeRaw: string; estimatedReceiveRaw: string }>(
        `/api/v1/cctp/quote?sourceChain=${sourceChain}&destChain=${BASE_CCTP_CHAIN_KEY}&amountRaw=${amountRaw}`,
      )
        .then((data) => { if (!cancelled) setQuote(data); })
        .catch(() => { if (!cancelled) setQuote(null); })
        .finally(() => { if (!cancelled) setQuoteLoading(false); });
    }, 400);
    return () => { cancelled = true; clearTimeout(t); setQuoteLoading(false); };
  }, [sourceChain, amount]);

  // Parsed amount for the balance check below — null (not an error) while
  // the field is empty/invalid, since that's already handled by the "Enter
  // a valid USDC amount" check inside handleFund.
  let amountRawForCheck: bigint | null = null;
  try {
    const v = parseUnits(amount || '0', 6);
    if (v > 0n) amountRawForCheck = v;
  } catch { /* leave null */ }
  // On a USDC-gas chain (Arc) the approve + burn gas comes out of the same
  // USDC, so only balance − reserve is bridgeable; bridging the full balance
  // would revert on-chain. The reserve is 0 on ETH-gas chains.
  const gasReserveRaw = BigInt(chains.find((c) => c.chainKey === sourceChain)?.usdcGasReserveRaw ?? '0');
  const spendableRaw = sourceBalance === null ? null : sourceBalance > gasReserveRaw ? sourceBalance - gasReserveRaw : 0n;
  const exceedsBalance = spendableRaw !== null && amountRawForCheck !== null && amountRawForCheck > spendableRaw;
  const insufficientGas = sourceGas !== null
    && (sourceGas.balance === 0n || (sourceGas.gasPrice !== null && sourceGas.balance < sourceGas.gasPrice * SOURCE_GAS_FLOOR_UNITS));
  const selectedChain = chains.find((c) => c.chainKey === sourceChain);
  const nativeSymbol = SOURCE_CHAIN_WALLET_CONFIG[sourceChain]?.nativeCurrency.symbol ?? 'ETH';
  const nativeShown = sourceGas
    ? (sourceGas.balance === 0n ? '0' : Number(formatUnits(sourceGas.balance, 18)).toLocaleString(undefined, { maximumSignificantDigits: 3 }))
    : null;

  async function pollTransfer(id: number) {
    for (let i = 0; i < 150; i++) { // ~10 min at 4s
      await new Promise((r) => setTimeout(r, 4000));
      if (abortedRef.current) return;
      try {
        const row = await authedGet<{ stage: string; mintTxHash: string | null; errorMessage: string | null }>(
          `/api/v1/cctp/deposit-intent/${id}`,
        );
        if (row.stage === 'mint_confirmed') {
          setMintTxHash(row.mintTxHash);
          setPhase('done');
          onFunded?.();
          return;
        }
        if (row.stage === 'failed') {
          setError(row.errorMessage || 'Transfer failed');
          setPhase('error');
          return;
        }
      } catch { /* transient — keep polling */ }
    }
    setError('Still bridging after 10 minutes. It may complete shortly — check back, or contact support with the transfer id.');
    setPhase('error');
  }

  async function handleFund() {
    setError('');
    if (!baseAddress) { setError('Connect your wallet first.'); return; }
    if (!externalWallet) { setError('Link an external wallet (e.g. MetaMask) to sign the source-chain transaction.'); return; }
    const chain = chains.find((c) => c.chainKey === sourceChain);
    if (!chain) { setError('Pick a source chain.'); return; }
    let amountRaw: bigint;
    try {
      amountRaw = parseUnits(amount || '0', 6);
      if (amountRaw <= 0n) throw new Error();
    } catch {
      setError('Enter a valid USDC amount.');
      return;
    }

    // Never sign without switching: calldata built for one chain's contracts
    // must not be signed on whatever chain the wallet happens to be on.
    const chainConfig = SOURCE_CHAIN_WALLET_CONFIG[chain.chainKey];
    if (!chainConfig) { setError(`${chain.label} isn't supported by this version of the app — reload the page.`); return; }
    const sendChain = { chainId: chain.chainId, rpcUrl: chainConfig.rpcUrls[0], label: chain.label };

    try {
      setPhase('switching');
      await switchWalletToChain(externalWallet, chain.chainId, chainConfig);

      const idempotencyKey = crypto.randomUUID();
      const intent = await authedPost<{
        transferId: number;
        approveTx?: { to: string; data: string; from: string };
        burnTx: { to: string; data: string; from: string };
      }>('/api/v1/cctp/deposit-intent', {
        sourceChain: chain.chainKey,
        amountRaw: amountRaw.toString(),
        mintRecipient: baseAddress,
        fromAddress: externalWallet.address,
        idempotencyKey,
      });
      setTransferId(intent.transferId);

      if (intent.approveTx) {
        setPhase('approving');
        const approved = await signAndSendDirect(externalWallet, intent.approveTx, sendChain);
        // The burn pulls USDC via transferFrom — without a mined approve it
        // can only revert, so stop here rather than ask for a doomed signature.
        if (approved.receipt?.status !== 1) {
          throw new Error(approved.receipt
            ? 'The USDC approval failed on-chain.'
            : 'The USDC approval hasn\'t confirmed yet. Check your wallet, then try again.');
        }
      }

      setPhase('burning');
      const burnSent = await signAndSendDirect(externalWallet, intent.burnTx, sendChain);

      setPhase('confirming');
      // The tx may not be mined yet by the time we ask — retry a few times
      // before treating a still-pending burn as a real problem.
      let confirmed = false;
      for (let i = 0; i < 10 && !confirmed; i++) {
        const row = await authedPost<{ stage: string; pending?: boolean; errorMessage?: string | null }>(
          `/api/v1/cctp/deposit-intent/${intent.transferId}/confirm`,
          { burnTxHash: burnSent.hash },
        );
        if (row.stage === 'burn_confirmed' || row.stage === 'attestation_pending' || row.stage === 'attestation_ready' || row.stage === 'mint_confirmed') {
          confirmed = true;
          break;
        }
        if (row.stage === 'failed') {
          setError(row.errorMessage || 'Burn transaction failed');
          setPhase('error');
          return;
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
      if (!confirmed) {
        setError('Burn transaction is taking a while to confirm — it may still land. Check back shortly.');
        setPhase('error');
        return;
      }

      setPhase('polling');
      await pollTransfer(intent.transferId);
    } catch (err) {
      setError((err as Error).message || 'Bridge failed');
      setPhase('error');
    }
  }

  const phaseLabel =
    phase === 'switching' ? 'Switching your wallet to the source chain…'
    : phase === 'approving' ? 'Confirm the USDC approval in your wallet…'
    : phase === 'burning' ? 'Confirm the transfer in your wallet…'
    : phase === 'confirming' ? 'Waiting for the burn to be mined…'
    : phase === 'polling' ? 'Bridging — Circle is minting USDC on Base…'
    : '';

  return (
    <Modal open onClose={onClose} dismissable={!busy} title="Fund from another chain" subtitle="Circle CCTP" size="md">
      <>
        {(phase === 'input' || phase === 'error') && (
          <div className="space-y-4">
            {!externalWallet && (
              <div className="text-xs text-warn border border-line bg-surface-2 p-3">
                No external wallet linked. You need one (e.g. MetaMask) to sign on the source chain — your Base
                wallet only holds/signs on Base.
                <div className="mt-2">
                  <Button variant="outline" size="sm" label="Link a wallet" onClick={() => connectWallet()} />
                </div>
              </div>
            )}
            <FormField
              label="From chain"
              hint={
                !externalWallet ? undefined
                : sourceBalance === null ? 'Checking balance…'
                : `Balance: ${parseFloat(formatUnits(sourceBalance, 6)).toFixed(4)} USDC${gasReserveRaw > 0n ? ` (${formatUnits(gasReserveRaw, 6)} USDC kept for network fees)` : ''}${nativeShown !== null ? ` · ${nativeShown} ${nativeSymbol} for gas` : ''}`
              }
            >
              <FormSelect value={sourceChain} onChange={(e) => setSourceChain(e.target.value)}>
                {chains.map((c) => (
                  <option key={c.chainKey} value={c.chainKey}>{c.label}</option>
                ))}
              </FormSelect>
            </FormField>
            <FormField
              label="Amount (USDC)"
              hint={
                exceedsBalance
                  ? gasReserveRaw > 0n
                    ? `Exceeds your balance after network fees (max ≈${formatUnits(spendableRaw ?? 0n, 6)} USDC).`
                    : 'Exceeds your balance on this chain.'
                : quoteLoading ? 'Quoting…'
                : quote ? `You'll receive ≈${parseFloat(formatUnits(quote.estimatedReceiveRaw, 6)).toFixed(4)} USDC on Base (fee ${formatUnits(quote.maxFeeRaw, 6)} USDC)`
                : undefined
              }
            >
              <div className="flex gap-2">
                <FormInput type="number" min="0" step="0.01" placeholder="10.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
                {externalWallet && spendableRaw !== null && (
                  <Button
                    variant="ghost"
                    size="sm"
                    label="Use max"
                    className="shrink-0"
                    disabled={spendableRaw <= 0n}
                    onClick={() => setAmount(formatUnits(spendableRaw, 6))}
                  />
                )}
              </div>
            </FormField>
            <div className="text-xs text-ink-3 border border-line bg-surface-2 p-3">
              This burns USDC on the source chain and mints native USDC to your Base wallet
              (<span className="font-mono">{baseAddress ? `${baseAddress.slice(0, 8)}…` : '—'}</span>) via Circle
              CCTP — usually a few minutes end to end. A small Circle fee is deducted on arrival.
            </div>
            {insufficientGas && (
              <div className="text-xs text-warn border border-warn/40 bg-warn/5 p-3">
                You need a little {nativeSymbol} on {selectedChain?.label ?? 'this chain'} to pay the network fee for the
                approval and transfer — this wallet has {nativeShown} {nativeSymbol}.{' '}
                {selectedChain?.isTestnet ? 'Get test ETH from a faucet, then try again.' : 'Add some, then try again.'}
              </div>
            )}
            {error && <div className="text-xs text-err break-words">{error}</div>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" label="Cancel" onClick={onClose} />
              <Button variant="primary" size="sm" label="Bridge USDC" onClick={handleFund} disabled={!externalWallet || chains.length === 0 || exceedsBalance || insufficientGas} />
            </div>
          </div>
        )}

        {busy && (
          <div className="py-8 text-center space-y-3">
            <div className="flex justify-center"><Spinner size={22} /></div>
            <div className="text-sm text-ink">{phaseLabel}</div>
            {transferId != null && <div className="font-mono text-xs text-ink-3">transfer #{transferId}</div>}
            <div className="text-xs text-ink-3">Don't close this window.</div>
          </div>
        )}

        {phase === 'done' && (
          <div className="py-6 text-center space-y-3">
            <div className="text-sm text-ok">USDC arrived on Base.</div>
            {mintTxHash && <div className="font-mono text-xs text-ink-3">mint tx {mintTxHash.slice(0, 10)}…</div>}
            <div className="flex justify-center pt-2">
              <Button variant="primary" size="sm" label="Done" onClick={onClose} />
            </div>
          </div>
        )}
      </>
    </Modal>
  );
}
