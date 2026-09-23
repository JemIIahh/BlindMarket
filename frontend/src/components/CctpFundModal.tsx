import { useState, useEffect, useRef } from 'react';
import { useWallets, usePrivy } from '@privy-io/react-auth';
import { parseUnits, formatUnits, JsonRpcProvider, BrowserProvider, Contract, Interface, ZeroAddress, zeroPadValue, id as keccakId } from 'ethers';
import { Button, FormField, FormInput, FormSelect, Modal, Spinner } from './bb';
import { get, authedPost, authedGet } from '../lib/api';
import { useWallet, switchWalletToChain, pauseWalletAutoSwitch, type AddEthereumChainParameter } from '../context/WalletContext';
import { signAndSendDirect } from '../lib/directSigner';
import { signAndSendTx } from '../lib/txSigner';
import {
  MAX_ESTIMATE_TOTAL,
  buildUnsignedOp,
  encodeBatch,
  encodeCreateAccount,
  estimateOp,
  getSmartAccount,
  pollOpReceipt,
  submitOp,
  userOpHash,
  type AaChain,
} from '../lib/userOp';
import { ARC_CHAIN_CONFIG, ARC_CHAIN_ID, SETTLEMENT_CCTP_CHAIN_KEY, isCctpUsable } from '../config/constants';

/**
 * DepositForBurn event (Circle CCTP V2 TokenMessenger) — field order and
 * indexed flags per developers.circle.com/cctp/references/contract-interfaces:
 * indexed = nonce, burnToken, depositor; the rest rides in data. Used to find
 * a burn the relay submitted as a UserOp (no L1 tx hash to /confirm with).
 */
const DEPOSIT_FOR_BURN_ABI = [
  'event DepositForBurn(uint64 indexed nonce, address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)',
];
const DEPOSIT_FOR_BURN_TOPIC = keccakId('DepositForBurn(uint64,address,uint256,address,bytes32,uint32,bytes32,bytes32,uint256,uint32)');

/**
 * CCTP Phase B (inbound) — fund the user's Arc wallet from USDC held on
 * another chain, via Circle's CCTP V2 burn-and-mint. The backend only ever
 * builds unsigned calldata for this direction (routes/cctp.ts); the actual
 * burn is signed here, directly, by the wallet that holds the source USDC — an
 * external wallet (MetaMask) or the Privy embedded wallet itself (for legacy
 * Base USDC). The mint recipient is the user's Arc wallet.
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
  'optimism-sepolia': {
    chainId: '0xaa37dc',
    chainName: 'Optimism Sepolia',
    nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://sepolia.optimism.io'],
    blockExplorerUrls: ['https://sepolia-optimism.etherscan.io'],
  },
  base: {
    chainId: '0x2105',
    chainName: 'Base',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://mainnet.base.org'],
    blockExplorerUrls: ['https://basescan.org'],
  },
  'base-sepolia': {
    chainId: '0x14a34',
    chainName: 'Base Sepolia',
    nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://sepolia.base.org'],
    blockExplorerUrls: ['https://sepolia.basescan.org'],
  },
  polygon: {
    chainId: '0x89',
    chainName: 'Polygon PoS',
    nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
    rpcUrls: ['https://polygon-rpc.com'],
    blockExplorerUrls: ['https://polygonscan.com'],
  },
  'polygon-amoy': {
    chainId: '0x13882',
    chainName: 'Polygon Amoy',
    nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
    rpcUrls: ['https://rpc-amoy.polygon.technology'],
    blockExplorerUrls: ['https://amoy.polygonscan.com'],
  },
};

// Source-chain gas check — a FLOOR, not an estimate: the burn alone uses
// ~105–126k gas (measured on Base Sepolia / Arc testnet), the approve adds
// ~45–55k, and Arbitrum adds its L1 data cost on top. A wallet below
// gasPrice × this floor can't possibly pay, so Bridge is blocked; above it the
// wallet has the final say. (Arc pays gas in USDC — covered by the reserve.)
const SOURCE_GAS_FLOOR_UNITS = 100_000n;

type Phase = 'input' | 'switching' | 'approving' | 'burning' | 'confirming' | 'polling' | 'done' | 'error'
  // External-wallet UserOp path (gas in USDC via the paymaster).
  | 'setting-up' | 'estimating' | 'signing-op' | 'submitting-op';

interface CctpChainOption {
  chainKey: string;
  chainId: number;
  usdcAddress: string;
  label: string;
  isTestnet?: boolean;
  /** USDC (6-dec raw) to leave on this chain for gas — non-zero only where
   *  gas is paid in USDC (Arc). Same number /deposit-intent enforces. */
  usdcGasReserveRaw?: string;
  /** The `chain` name POST /tx/relay-tx takes for this chain, or null when
   *  the relay doesn't serve it. Set, the embedded signer relays (USDC gas);
   *  unset or external signer, the wallet signs directly (native gas). */
  relayChain?: string | null;
  /** ERC-4337 USDC-gas for external wallets, or null where undeployed. */
  aa?: { paymaster: string; factory: string; entrypoint: string } | null;
  /** Backend bundler wired for this chain: aa + this is the UserOp path. */
  userOpRelay?: boolean;
}

// Extra USDC the smart account must hold above the bridged amount to cover
// the paymaster's charge. Leftovers stay in the account, reusable next time.
const USEROP_USDC_BUFFER_RAW = 1_000_000n;
// Source-chain gas floor for the one-time smart-account setup (CREATE2
// deploy ~1.2M + funding transfer), vs the burn-only floor below.
const SETUP_GAS_FLOOR_UNITS = 1_500_000n;

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
  // True while the in-flight flow relays the source-chain txs (USDC gas).
  const [viaRelay, setViaRelay] = useState(false);
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
        const sources = data.chains.filter((c) => c.chainKey !== SETTLEMENT_CCTP_CHAIN_KEY && SOURCE_CHAIN_WALLET_CONFIG[c.chainKey]);
        setChains(sources);
        if (sources.length > 0) setSourceChain((prev) => prev || sources[0].chainKey);
      })
      .catch(() => setError('Could not load supported chains.'));
  }, []);

  // The embedded (Privy) wallet is the mint recipient on Arc. The burn is
  // signed by whichever wallet holds the source-chain USDC: a linked external
  // wallet (MetaMask), or the embedded wallet itself when the user's USDC
  // lives there (e.g. legacy Base USDC in their Privy wallet).
  const embeddedWallet = wallets.find((w) => w.walletClientType === 'privy') ?? null;
  const externalSigner = wallets.find((w) => w.walletClientType !== 'privy') ?? null;
  const signerWallet = externalSigner ?? embeddedWallet;

  const busy = phase === 'switching' || phase === 'approving' || phase === 'burning' || phase === 'confirming' || phase === 'polling'
    || phase === 'setting-up' || phase === 'estimating' || phase === 'signing-op' || phase === 'submitting-op';

  // Live balance on the chosen source chain — a direct read against a public
  // RPC, no wallet interaction (and no chain switch) needed just to read it.
  // Lets the amount field be validated against what the user actually holds
  // BEFORE they go through switching chains and signing.
  useEffect(() => {
    const chain = chains.find((c) => c.chainKey === sourceChain);
    const rpcUrl = SOURCE_CHAIN_WALLET_CONFIG[sourceChain]?.rpcUrls[0];
    if (!chain || !rpcUrl || !signerWallet) { setSourceBalance(null); setSourceGas(null); return; }
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
            provider.getBalance(signerWallet.address),
            provider.send('eth_gasPrice', []).catch(() => null) as Promise<string | null>,
          ]);
          return { balance, gasPrice: gasPriceHex ? BigInt(gasPriceHex) : null };
        } catch {
          return null;
        }
      })();
      try {
        const usdc = new Contract(chain.usdcAddress, ['function balanceOf(address) view returns (uint256)'], provider);
        const bal: bigint = await usdc.balanceOf(signerWallet.address);
        if (!cancelled) setSourceBalance(bal);
      } catch {
        if (!cancelled) setSourceBalance(null);
      }
      const gas = await gasRead;
      if (!cancelled) setSourceGas(gas);
    })();
    return () => { cancelled = true; };
  }, [sourceChain, signerWallet?.address, chains]);

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
        `/api/v1/cctp/quote?sourceChain=${sourceChain}&destChain=${SETTLEMENT_CCTP_CHAIN_KEY}&amountRaw=${amountRaw}`,
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
  const selectedChain = chains.find((c) => c.chainKey === sourceChain);
  // The embedded signer relays on a relay-served chain (gas in USDC), so the
  // native-gas floor doesn't apply; external signers always pay native gas.
  const useRelayForGas = !!selectedChain?.relayChain && signerWallet?.walletClientType === 'privy';
  // External signer on a UserOp-capable chain: the smart account pays gas in
  // USDC via the paymaster (after a one-time native-gas setup below).
  const useUserOpForGas = !!selectedChain?.userOpRelay && !!selectedChain?.aa && !!externalSigner;
  // On a USDC-gas chain (Arc) the approve + burn gas comes out of the same
  // USDC, so only balance − reserve is bridgeable; bridging the full balance
  // would revert on-chain. The reserve is 0 on ETH-gas chains. On the UserOp
  // path the EOA instead funds the smart account with amount + buffer (the
  // paymaster's charge comes out of that buffer; leftovers stay reusable).
  const gasReserveRaw = BigInt(chains.find((c) => c.chainKey === sourceChain)?.usdcGasReserveRaw ?? '0');
  const effectiveReserve = useUserOpForGas ? USEROP_USDC_BUFFER_RAW : gasReserveRaw;
  const spendableRaw = sourceBalance === null ? null : sourceBalance > effectiveReserve ? sourceBalance - effectiveReserve : 0n;
  const exceedsBalance = spendableRaw !== null && amountRawForCheck !== null && amountRawForCheck > spendableRaw;
  // Deployed smart account of the external signer on this chain (null until
  // read, or when none exists yet) — drives the setup hint + gas floor.
  const [smartAccount, setSmartAccount] = useState<string | null>(null);
  useEffect(() => {
    const chain = chains.find((c) => c.chainKey === sourceChain);
    const rpcUrl = SOURCE_CHAIN_WALLET_CONFIG[sourceChain]?.rpcUrls[0];
    if (!chain?.aa || !externalSigner || !rpcUrl) { setSmartAccount(null); return; }
    let cancelled = false;
    setSmartAccount(null);
    getSmartAccount(chain.aa.factory, externalSigner.address, rpcUrl, chain.chainId)
      .then((a) => { if (!cancelled) setSmartAccount(a && a !== ZeroAddress ? a : null); })
      .catch(() => { if (!cancelled) setSmartAccount(null); });
    return () => { cancelled = true; };
  }, [sourceChain, externalSigner?.address, chains]);
  // First bridge on a chain needs the account deployed (~1.2M gas) plus the
  // funding transfer; later ones only need the burn floor.
  const gasFloorUnits = useUserOpForGas && !smartAccount ? SETUP_GAS_FLOOR_UNITS : SOURCE_GAS_FLOOR_UNITS;
  const insufficientGas = !useRelayForGas && sourceGas !== null
    && (sourceGas.balance === 0n || (sourceGas.gasPrice !== null && sourceGas.balance < sourceGas.gasPrice * gasFloorUnits));
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
    if (!signerWallet) { setError('Connect a wallet to sign the source-chain transaction.'); return; }
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

    // Embedded signer on a relay-served chain: the backend relay sponsors gas
    // (user-pays USDC, falling back down the ladder). Anything else — an
    // external signer, or a chain the relay doesn't serve — signs directly
    // and pays that chain's native gas (except Arc, which is USDC natively).
    const useRelay = signerWallet.walletClientType === 'privy' && !!chain.relayChain;
    setViaRelay(useRelay);
    const sendSourceTx = async (tx: { to: string; data: string; from: string }) => {
      if (useRelay) {
        const eth = await signerWallet.getEthereumProvider();
        const ethersSigner = await new BrowserProvider(eth).getSigner();
        const sent = await signAndSendTx(ethersSigner, tx, undefined, { relay: chain.relayChain!, rpcUrl: sendChain.rpcUrl });
        return { hash: sent.hash, receipt: sent.receipt, userOp: sent.userOp ?? false };
      }
      const sent = await signAndSendDirect(signerWallet, tx, sendChain);
      return { ...sent, userOp: false };
    };
    // A relayed approve lands as a UserOp with no receipt to check — wait for
    // the allowance itself instead. Works for the direct path too.
    const pollAllowance = async (owner: string, spender: string, need: bigint) => {
      const provider = new JsonRpcProvider(sendChain.rpcUrl, chain.chainId, { staticNetwork: true });
      const usdc = new Contract(chain.usdcAddress, ['function allowance(address,address) view returns (uint256)'], provider);
      for (let i = 0; i < 40; i++) {
        try {
          if (BigInt(await usdc.allowance(owner, spender)) >= need) return;
        } catch { /* RPC hiccup; keep waiting */ }
        await new Promise((r) => setTimeout(r, 3000));
      }
      throw new Error("The USDC approval hasn't confirmed yet. Check your wallet, then try again.");
    };
    // A UserOp hash is not an L1 tx hash, so /confirm can't take it — find
    // the burn the UserOp submitted by scanning the messenger's
    // DepositForBurn events for ours (depositor + token + amount + recipient).
    const findBurnTxHash = async (messenger: string, fromBlock: number | null): Promise<string> => {
      const provider = new JsonRpcProvider(sendChain.rpcUrl, chain.chainId, { staticNetwork: true });
      const iface = new Interface(DEPOSIT_FOR_BURN_ABI);
      const usdcTopic = zeroPadValue(chain.usdcAddress, 32);
      const depositorTopic = zeroPadValue(signerWallet.address, 32);
      const wantRecipient = zeroPadValue(baseAddress, 32).toLowerCase();
      let start = fromBlock;
      for (let i = 0; i < 75; i++) { // ~5 min at 4s
        try {
          start ??= await provider.getBlockNumber();
          const latest = await provider.getBlockNumber();
          const logs = await provider.getLogs({
            address: messenger,
            topics: [DEPOSIT_FOR_BURN_TOPIC, null, usdcTopic, depositorTopic],
            fromBlock: start,
            toBlock: latest,
          });
          for (const log of logs) {
            try {
              const parsed = iface.parseLog(log);
              if (
                parsed &&
                BigInt(parsed.args.amount) === amountRaw &&
                String(parsed.args.mintRecipient).toLowerCase() === wantRecipient
              ) {
                return log.transactionHash;
              }
            } catch { /* not ours; keep scanning */ }
          }
        } catch { /* RPC hiccup; keep polling */ }
        await new Promise((r) => setTimeout(r, 4000));
      }
      throw new Error('The sponsored transfer was submitted but its burn could not be found yet. Wait a minute and check back.');
    };

    // Hold the wallet on the source chain until the burn is sent: the Arc
    // auto-switch (WalletContext) would otherwise pull the embedded wallet
    // back and fail the first signature. Afterwards an embedded wallet goes
    // back to Arc, where posting signs; a linked external wallet stays put.
    const releaseAutoSwitch = pauseWalletAutoSwitch();
    let restored = false;
    const restoreWallet = () => {
      if (restored) return;
      restored = true;
      releaseAutoSwitch();
      if (signerWallet.walletClientType === 'privy') {
        switchWalletToChain(signerWallet, ARC_CHAIN_ID, ARC_CHAIN_CONFIG).catch(() => { /* the chain banner offers a switch */ });
      }
    };

    try {
      setPhase('switching');
      await switchWalletToChain(signerWallet, chain.chainId, chainConfig);

      const idempotencyKey = crypto.randomUUID();

      // External signer on a UserOp-capable chain: the smart account pays gas
      // in USDC via the paymaster. Every other combination uses the EOA legs
      // (direct native-gas sign, or the relay for the embedded wallet).
      const useUserOp = !!chain.userOpRelay && !!chain.aa && signerWallet.walletClientType !== 'privy';

      const createIntent = (from: string) => authedPost<{
        transferId: number;
        approveTx?: { to: string; data: string; from: string };
        burnTx: { to: string; data: string; from: string };
      }>('/api/v1/cctp/deposit-intent', {
        sourceChain: chain.chainKey,
        amountRaw: amountRaw.toString(),
        mintRecipient: baseAddress,
        fromAddress: from,
        idempotencyKey,
      });

      // One-time setup of the smart account (native gas, direct signs):
      // deploy it when missing, then top it to amount + buffer so the
      // paymaster's charge clears. Both are yours and reusable afterwards.
      const ensureSmartAccount = async (): Promise<string> => {
        const reader = new JsonRpcProvider(sendChain.rpcUrl, chain.chainId, { staticNetwork: true });
        const factory = new Contract(chain.aa!.factory, ['function accounts(address) view returns (address)'], reader);
        const existing: string = await factory.accounts(signerWallet.address);
        if (existing && existing !== ZeroAddress) return existing;
        setPhase('setting-up');
        const built = await signAndSendDirect(
          signerWallet,
          { to: chain.aa!.factory, data: encodeCreateAccount(signerWallet.address), from: signerWallet.address },
          sendChain,
        );
        if (built.receipt?.status === 0) throw new Error('Smart account deployment failed on-chain.');
        const addr: string = await factory.accounts(signerWallet.address);
        if (!addr || addr === ZeroAddress) {
          throw new Error('Smart account deployment is taking a while — wait a minute and try again.');
        }
        return addr;
      };

      const ensureFunded = async (smart: string): Promise<void> => {
        const reader = new JsonRpcProvider(sendChain.rpcUrl, chain.chainId, { staticNetwork: true });
        const usdc = new Contract(chain.usdcAddress, ['function balanceOf(address) view returns (uint256)'], reader);
        const need = amountRaw + USEROP_USDC_BUFFER_RAW;
        const bal: bigint = await usdc.balanceOf(smart).catch(() => 0n);
        if (bal >= need) return;
        setPhase('setting-up');
        const data = new Interface(['function transfer(address to, uint256 amount)'])
          .encodeFunctionData('transfer', [smart, need - bal]);
        const sent = await signAndSendDirect(
          signerWallet,
          { to: chain.usdcAddress, data, from: signerWallet.address },
          sendChain,
        );
        if (sent.receipt?.status === 0) throw new Error('Funding transfer failed on-chain.');
        for (let i = 0; i < 20; i++) {
          try {
            if (BigInt(await usdc.balanceOf(smart)) >= need) return;
          } catch { /* RPC hiccup; keep waiting */ }
          await new Promise((r) => setTimeout(r, 3000));
        }
        throw new Error('Funding transfer is taking a while — wait a minute and try again.');
      };

      // The intent's own calldata as one smart-account batch, estimated,
      // raw-signed (the account validates the raw digest) and submitted
      // through the backend. Returns the L1 bundle tx hash.
      const sendViaUserOp = async (
        opIntent: { transferId: number; approveTx?: { data: string }; burnTx: { to: string; data: string } },
        smart: string,
      ): Promise<string> => {
        const aaCfg: AaChain = {
          paymaster: chain.aa!.paymaster,
          factory: chain.aa!.factory,
          entrypoint: chain.aa!.entrypoint,
          usdc: chain.usdcAddress,
          chainId: chain.chainId,
          rpcUrl: sendChain.rpcUrl,
        };
        const calls = [
          ...(opIntent.approveTx ? [{ to: chain.usdcAddress, value: 0n, data: opIntent.approveTx.data }] : []),
          { to: opIntent.burnTx.to, value: 0n, data: opIntent.burnTx.data },
        ];
        setPhase('estimating');
        let op = await buildUnsignedOp(aaCfg, smart, encodeBatch(calls));
        // Best-effort: the bundler pads estimates past the paymaster's 1M
        // cap today, so its answer is only taken when it fits under it —
        // otherwise the fixed limits (sized for approve+burn) stand.
        try {
          const gas = await estimateOp(opIntent.transferId, op);
          const total = Number(BigInt(gas.callGasLimit) + BigInt(gas.verificationGasLimit) + BigInt(gas.preVerificationGas)) + 100_000;
          if (total < MAX_ESTIMATE_TOTAL) {
            op = { ...op, callGasLimit: gas.callGasLimit, verificationGasLimit: gas.verificationGasLimit, preVerificationGas: gas.preVerificationGas };
          }
        } catch {
          /* fixed limits stand */
        }
        setPhase('signing-op');
        const hash = userOpHash(op, aaCfg.entrypoint, aaCfg.chainId);
        const eth = await signerWallet.getEthereumProvider();
        let signature: string;
        try {
          signature = await eth.request({ method: 'eth_sign', params: [signerWallet.address, hash] }) as string;
        } catch {
          throw new Error('Your wallet refused the batch signature (eth_sign) — approve it to pay gas in USDC. Anything already moved sits in your smart account, owned by you; closing and bridging with native gas still works.');
        }
        setPhase('submitting-op');
        const opHash = await submitOp(opIntent.transferId, { ...op, signature });
        return pollOpReceipt(chain.chainKey, opHash);
      };

      let burnHash: string;
      let activeTransferId: number;
      let confirmBody: { burnTxHash: string } | { bundleTxHash: string };
      if (useUserOp) {
        const smart = await ensureSmartAccount();
        await ensureFunded(smart);
        const opIntent = await createIntent(smart);
        setTransferId(opIntent.transferId);
        activeTransferId = opIntent.transferId;
        burnHash = await sendViaUserOp(opIntent, smart);
        confirmBody = { bundleTxHash: burnHash };
      } else {
        const intent = await createIntent(signerWallet.address);
        setTransferId(intent.transferId);
        activeTransferId = intent.transferId;

        if (intent.approveTx) {
          setPhase('approving');
          const approved = await sendSourceTx(intent.approveTx);
          // The burn pulls USDC via transferFrom — without a mined approve it
          // can only revert, so stop here rather than ask for a doomed signature.
          if (approved.receipt?.status === 0) {
            throw new Error('The USDC approval failed on-chain.');
          }
          if (approved.receipt?.status !== 1) {
            // Relayed as a UserOp (or receipt not yet visible): wait for the
            // allowance itself instead of a receipt.
            const [spender] = new Interface(['function approve(address spender, uint256 amount)'])
              .decodeFunctionData('approve', intent.approveTx.data);
            await pollAllowance(intent.approveTx.from, String(spender), amountRaw);
          }
        }

        setPhase('burning');
        const readChain = new JsonRpcProvider(sendChain.rpcUrl, chain.chainId, { staticNetwork: true });
        const burnFromBlock = await readChain.getBlockNumber().catch(() => null);
        const burnSent = await sendSourceTx(intent.burnTx);

        // A UserOp hash is not an L1 tx hash — find the burn it submitted first.
        burnHash = burnSent.userOp
          ? await findBurnTxHash(intent.burnTx.to, burnFromBlock)
          : burnSent.hash;
        confirmBody = { burnTxHash: burnHash };
      }
      restoreWallet();

      setPhase('confirming');
      // The tx may not be mined yet by the time we ask — retry a few times
      // before treating a still-pending burn as a real problem.
      let confirmed = false;
      for (let i = 0; i < 10 && !confirmed; i++) {
        const row = await authedPost<{ stage: string; pending?: boolean; errorMessage?: string | null }>(
          `/api/v1/cctp/deposit-intent/${activeTransferId}/confirm`,
          confirmBody,
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
      await pollTransfer(activeTransferId);
    } catch (err) {
      setError((err as Error).message || 'Bridge failed');
      setPhase('error');
    } finally {
      restoreWallet();
    }
  }

  const phaseLabel =
    phase === 'switching' ? 'Switching your wallet to the source chain…'
    : phase === 'approving' ? (viaRelay ? 'Approving USDC (gas paid in USDC)…' : 'Confirm the USDC approval in your wallet…')
    : phase === 'burning' ? (viaRelay ? 'Bridging (gas paid in USDC)…' : 'Confirm the transfer in your wallet…')
    : phase === 'setting-up' ? 'Setting up your smart account (one-time, native gas)…'
    : phase === 'estimating' ? 'Estimating the sponsored transaction…'
    : phase === 'signing-op' ? 'Sign the batch in your wallet (gas paid in USDC)…'
    : phase === 'submitting-op' ? 'Submitting the sponsored transaction…'
    : phase === 'confirming' ? 'Waiting for the burn to be mined…'
    : phase === 'polling' ? 'Bridging — Circle is minting USDC on Arc…'
    : '';

  return (
    <Modal open onClose={onClose} dismissable={!busy} title="Fund from another chain" subtitle="Circle CCTP" size="md">
      <>
        {(phase === 'input' || phase === 'error') && (
          <div className="space-y-4">
            {signerWallet && (
              <div className="text-xs text-ink-3 border border-line bg-surface-2 p-3 flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>
                  Signing from your <span className="text-ink">{externalSigner ? 'linked' : 'BlindMarket'} wallet</span>{' '}
                  <span className="font-mono">{signerWallet.address.slice(0, 6)}…{signerWallet.address.slice(-4)}</span>.
                </span>
                {!externalSigner && (
                  <>
                    <span>USDC in another wallet?</span>
                    <button type="button" className="underline text-ink hover:text-cream transition-colors" onClick={() => connectWallet()}>
                      Link it
                    </button>
                  </>
                )}
              </div>
            )}
            {!signerWallet && (
              <div className="text-xs text-warn border border-line bg-surface-2 p-3">
                Your wallet isn't ready yet. Sign in to bridge your USDC, or link an external wallet (e.g. MetaMask)
                if your USDC is held there.
                <div className="mt-2">
                  <Button variant="outline" size="sm" label="Link a wallet" onClick={() => connectWallet()} />
                </div>
              </div>
            )}
            <FormField
              label="From chain"
              hint={
                !signerWallet ? undefined
                : sourceBalance === null ? 'Checking balance…'
                : `Balance: ${parseFloat(formatUnits(sourceBalance, 6)).toFixed(4)} USDC${gasReserveRaw > 0n ? ` (${formatUnits(gasReserveRaw, 6)} USDC kept for network fees)` : ''}${useRelayForGas ? ' · gas paid in USDC (sponsored)' : useUserOpForGas ? ` · gas paid in USDC (paymaster)${smartAccount ? '' : ' · one-time account setup applies'}` : nativeShown !== null ? ` · ${nativeShown} ${nativeSymbol} for gas` : ''}`
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
                    : useUserOpForGas
                      ? `Exceeds your balance after the paymaster buffer (max ≈${formatUnits(spendableRaw ?? 0n, 6)} USDC).`
                      : 'Exceeds your balance on this chain.'
                : quoteLoading ? 'Quoting…'
                : quote ? `You'll receive ≈${parseFloat(formatUnits(quote.estimatedReceiveRaw, 6)).toFixed(4)} USDC on Arc (fee ${formatUnits(quote.maxFeeRaw, 6)} USDC)`
                : undefined
              }
            >
              <div className="flex gap-2">
                <FormInput type="number" min="0" step="0.01" placeholder="10.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
                {signerWallet && spendableRaw !== null && (
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
              This burns USDC on the source chain and mints native USDC to your Arc wallet
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
              <Button variant="primary" size="sm" label="Bridge USDC" onClick={handleFund} disabled={!signerWallet || chains.length === 0 || exceedsBalance || insufficientGas} />
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
            <div className="text-sm text-ok">USDC arrived on Arc.</div>
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
