import { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useWalletClient } from 'wagmi';
import { BrowserProvider, Contract, Interface, formatUnits, parseUnits, type JsonRpcSigner } from 'ethers';
import {
  Breadcrumb,
  PageHeader,
  SectionRule,
  Button,
  Icon,
  FormField,
  FormInput,
  FormSelect,
  ConfirmDialog,
  CopyButton,
  ErrorNotice,
} from '../components/bb';
import { ToolManager, type AnyTool } from '../components/bb/ToolManager';
import SkillPicker from '../components/bb/SkillPicker';
import { get, authedGet, authedPost } from '../lib/api';
import { providerFor, sendDirectPayment, signAndSendTx } from '../lib/txSigner';
import { useWallet } from '../context/WalletContext';
import { useAuth } from '../context/AuthContext';
import { useChainAddress } from '../hooks/useChainWallet';
import { unlinkedSignerError } from '../lib/accountWallet';
import { getOrCreateExecutorIdentity } from '../lib/executorIdentity';
import { ARC_AGENT_FACTORY_ADDRESS, ARC_CHAIN_CONFIG, ARC_CHAIN_ID, ARC_USDC_ADDRESS } from '../config/constants';
import { OG_COMPUTE_ACCOUNT_0G, OG_COMPUTE_START_0G } from '../lib/agentReadiness';
import { formatMinGas, minGasBalance } from '../lib/agentGas';
import {
  gasIsSettlementToken, getMarketplaceTokenAddress, getPaymentDecimals, getPaymentSymbol, isNativePayment, useSettlement,
} from '../config/settlement';
import {
  agentNames, capacityCheck, freeSlots, maxDeployable, namesProblem, runDeploys,
  type AgentCapacity, type AgentRun, type DeployedAgent,
} from '../lib/bulkDeploy';
import {
  FEE_HEARTBEAT_MS, addFee, browserFeeStorage, claimFee, dropFee, freeFees, releaseFees, touchFees,
} from '../lib/pendingFees';
import { WARN_BOX } from '../components/agent/AgentReadinessCard';
import {
  CUSTOM_MODEL, FALLBACK_MODELS, isKeyed, isPriced, liveListError, liveListRequest,
  modelLabel, modelOptions as optionsFor, providerLabel, usdPer1M,
  type ModelOption, type Provider,
} from '../lib/llmModels';

/**
 * What deploying charges (GET /api/v1/agents/deploy-fee). On a stack with an
 * Arc escrow — production — this page pays it as one USDC transfer to the
 * escrow's treasury and names that transaction in the deploy request.
 * Otherwise it pays through AgentFactory on Arc, whose event the backend
 * turns into a deploy credit.
 */
type DeployFeeTerms =
  | { required: false }
  | { required: true; method: 'transfer'; chain: 'arc'; token: string; recipient: string; amountRaw: string; decimals: number; factory: string | null }
  | { required: true; method: 'factory'; chain: 'arc'; factory: string | null };

// AgentFactory on Arc — accepts USDC, emits AgentDeployed event
const AGENT_FACTORY_ABI = [
  'function deployAgent(uint256 usdcAmount) external',
  'function getTotalCost(uint256 usdcAmount) external view returns (uint256)',
  'function deployFeeUsdc() external view returns (uint256)',
];

const USDC_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address owner) external view returns (uint256)',
  'function transfer(address to, uint256 amount) external returns (bool)',
];

// AgentFactory's deploy fee: 1 USDC (6 decimals)
const DEPLOY_FEE_USDC = 1_000_000n;
// Arc gas is paid from the same USDC balance. A USDC transfer used ~49k gas,
// under 0.0023 USDC at Arc testnet's max fee (measured Sep 2026).
const ARC_GAS_MARGIN = 10_000n; // 0.01 USDC

/** "1", "2.5" — a 6-decimal USDC amount for display. */
const usdc = (raw: bigint) => String(Number(formatUnits(raw, 6)));

// A fee paid on Arc but not yet used for a deploy (the deploy failed, or the
// tab closed after paying), kept per owner so the retry uses it instead of
// charging again. Every tab shares them: a run takes only one no other live
// run holds (lib/pendingFees.ts).
const firstFreeFee = (owner: string): string | null => freeFees(browserFeeStorage, owner, Date.now())[0]?.hash ?? null;
const newRunId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const shortHash = (hash: string) => `${hash.slice(0, 10)}…${hash.slice(-6)}`;
const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

// What a funding transfer suggests per agent, in USDC: many transactions'
// gas on Arc. The owner edits it before deploying.
const DEFAULT_FUND_AMOUNT = '0.05';

/**
 * GET /api/v1/agents/capacity, or null when it can't be read (a backend
 * without the route, or a network hiccup): then the deploy itself refuses an
 * agent that can't start, before any fee.
 */
async function readCapacity(): Promise<AgentCapacity | null> {
  try {
    return await authedGet<AgentCapacity>('/api/v1/agents/capacity');
  } catch {
    return null;
  }
}

/** What a run's progress row says about an agent. */
const RUN_STATE_LABEL: Record<AgentRun['state'], string> = {
  queued: 'Waiting',
  paying: 'Paying deploy fee…',
  deploying: 'Creating agent…',
  funding: 'Funding wallet…',
  done: 'Deployed',
  failed: 'Failed',
  skipped: 'Not deployed',
};

type ProviderModels = Record<Provider, string[]>;
type PricingMap = Record<Provider, ModelOption[]>;

/** snake_case capability id → human label ("web_research" → "Web research"). */
const INSTRUCTION_TEMPLATES: Record<string, string> = {
  webResearch: `# Web Research Agent

You are a web research agent. Your job is to find, verify, and summarize information from the web.

## Capabilities
- Perform deep web searches on any topic
- Extract and verify key facts from multiple sources
- Provide citations and source links

## Behavior
- Always verify information from at least 2 independent sources
- Flag uncertainty or conflicting information clearly
- Provide structured summaries with key takeaways

## Output format
Start every response with a brief **summary**, then list findings with sources.`,
  dataProcessing: `# Data Processing Agent

You process and transform data according to specified rules.

## Capabilities
- Parse structured and unstructured data
- Transform between formats (JSON, CSV, text)
- Validate data against schemas

## Behavior
- Never modify data beyond the specified transformation
- Report errors and malformed input clearly
- Log processing steps for auditability

## Output format
Return processed data in the requested format with a brief summary of what was done.`,
  communityManager: `# Community Manager Agent

You manage community interactions, moderate content, and engage with users.

## Capabilities
- Moderate messages and content against guidelines
- Respond to common questions with approved answers
- Escalate complex issues to human moderators

## Behavior
- Be polite, helpful, and professional at all times
- Strictly enforce community guidelines without exception
- Use judgment — not everything rule-breaking is explicit

## Escalation
When you cannot handle something, clearly state why and offer to escalate.`,
  codeReview: `# Code Review Agent

You review code for bugs, security issues, and best practices.

## Capabilities
- Analyze code for common vulnerabilities
- Check for style guide compliance
- Suggest optimizations

## Behavior
- Be constructive — point out what's good too
- Prioritize security issues over style
- Provide examples for suggested changes`,
};

export default function DeployAgentForm() {
  const address = useChainAddress();
  const { data: walletClient } = useWalletClient();
  // The wallet's own network. wagmi's useChainId only ever reports the chains
  // in its config (Arc), so it cannot tell a wallet sitting elsewhere.
  const { chainId: walletChainId, embeddedAddress, externalAddresses, switchChain } = useWallet();
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  // Re-render when the backend's settlement answer arrives (config/settlement.ts).
  const settlement = useSettlement();
  const posting = settlement.chains[settlement.postingChain];

  // FALLBACK_MODELS until /api/v1/agents/providers answers.
  const [providers, setProviders] = useState<ProviderModels>(FALLBACK_MODELS);
  const [pricing, setPricing] = useState<PricingMap>({} as PricingMap);

  const [form, setForm] = useState({
    name: '',
    instructions: '',
    provider: '0g-compute' as Provider,
    model: 'glm-5',
    apiKey: '',
  });

  // Live list from the selected provider's own /models endpoint, fetched with
  // the key the user pasted (keyless for 0G). Null until a key is present or
  // if the lookup failed — the static catalog stands in until then.
  const [live, setLive] = useState<{ provider: Provider; models: ModelOption[] } | null>(null);
  const [liveStatus, setLiveStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [liveError, setLiveError] = useState('');
  // The key as last pasted or blurred. Discovery keys off this rather than
  // every keystroke, so a half-typed key is never relayed to the provider.
  const [committedKey, setCommittedKey] = useState('');

  // An id the owner types, for a model the list doesn't have yet. The backend
  // checks it against the provider's list with the key before any fee.
  const [customModel, setCustomModel] = useState(false);
  // Read by the live lookup when it answers, which may be after a toggle.
  const customModelRef = useRef(customModel);
  customModelRef.current = customModel;

  const modelOptions = optionsFor(form.provider, live, providers[form.provider] ?? [], pricing[form.provider]);
  const currentModel = modelOptions.find(m => m.id === form.model.trim());
  const providerName = providerLabel(form.provider);

  const [showTemplateMenu, setShowTemplateMenu] = useState(false);

  useEffect(() => {
    if (!showTemplateMenu) return;
    function onDown(e: MouseEvent) {
      const btn = (e.target as HTMLElement).closest('[data-tmpl-btn]');
      if (!btn) setShowTemplateMenu(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [showTemplateMenu]);

  const [tools, setTools] = useState<AnyTool[]>([]);
  const [toolSecrets, setToolSecrets] = useState<Record<string, string>>({});
  // Installed skills (slugs).
  const [skillSlugs, setSkillSlugs] = useState<string[]>([]);
  // Slugs imported as PRIVATE drafts via the SkillPicker importer. The deploy
  // route installs public skills only, so these are listed on the success
  // screen for the owner to install from the agent's Skills panel instead.
  const [privateSkillSlugs, setPrivateSkillSlugs] = useState<string[]>([]);

  const [status, setStatus] = useState<'idle' | 'checking' | 'confirming' | 'approving' | 'paying' | 'deploying' | 'funding' | 'done' | 'error'>('idle');
  const submittingRef = useRef(false);
  const confirmResolveRef = useRef<((approve: boolean) => void) | null>(null);
  const [error, setError] = useState<unknown>('');
  const [deployed, setDeployed] = useState<{
    id: string;
    started: boolean;
    feeTx: string | null;
    /** Set for a 0g-compute agent: the wallet the owner funds with 0G next. */
    ogFundAddress: string | null;
    /** The transfer that funded its wallet, when the owner asked for one. */
    fundTx?: string;
    fundError?: unknown;
  } | null>(null);

  // How many agents to deploy, and every agent of the run in progress (or
  // the one just finished) with what became of it.
  const [count, setCount] = useState(1);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [runAt, setRunAt] = useState(0);
  // How many agents can start now, from the backend's worker limit. Null
  // when it can't be read: the deploy then refuses one that can't start.
  const [capacity, setCapacity] = useState<AgentCapacity | null>(null);
  // Set when a run asked for more agents than can start: the number that can.
  const [capacityOffer, setCapacityOffer] = useState<number | null>(null);
  useEffect(() => {
    if (!isAuthenticated || (status !== 'idle' && status !== 'done' && status !== 'error')) return;
    let cancelled = false;
    void readCapacity().then((c) => { if (!cancelled) setCapacity(c); });
    return () => { cancelled = true; };
  }, [isAuthenticated, address, status]);
  const maxCount = maxDeployable(capacity);
  // A lower limit read later pulls the number down with it.
  useEffect(() => { setCount((c) => Math.min(c, Math.max(1, maxCount))); }, [maxCount]);
  const free = freeSlots(capacity);
  const names = agentNames(form.name, count);

  // Funding each agent's wallet as it deploys: off unless asked for, and not
  // offered where BlindMarket pays agents' gas or where gas isn't paid in an
  // ERC-20 payment token this page can send.
  const [gasSponsored, setGasSponsored] = useState(false);
  useEffect(() => {
    let cancelled = false;
    get<{ gasSponsor?: { enabled?: boolean; paused?: boolean; killed?: boolean } }>('/health/bridge')
      .then((d) => {
        const g = d.gasSponsor;
        if (!cancelled) setGasSponsored(g?.enabled === true && g.paused !== true && g.killed !== true);
      })
      .catch(() => { /* unknown: the option stays offered */ });
    return () => { cancelled = true; };
  }, []);
  const fundingOffered = !gasSponsored && !isNativePayment();
  const [fundOn, setFundOn] = useState(false);
  const [fundAmount, setFundAmount] = useState(DEFAULT_FUND_AMOUNT);
  const funding = fundOn && fundingOffered;
  const fundRaw = (() => {
    if (!funding) return 0n;
    try {
      const raw = parseUnits(fundAmount.trim(), getPaymentDecimals());
      return raw > 0n ? raw : null;
    } catch {
      return null;
    }
  })();
  // What one worker transaction can cost at current fees (lib/agentGas.ts):
  // below it an agent takes no task.
  const [minGasRaw, setMinGasRaw] = useState<bigint | null>(null);
  useEffect(() => {
    setMinGasRaw(null);
    if (!fundOn || !gasIsSettlementToken(posting.key)) return;
    let cancelled = false;
    providerFor(posting.key).getFeeData()
      .then((fee) => {
        const perGas = fee.maxFeePerGas ?? fee.gasPrice;
        if (!cancelled && perGas) setMinGasRaw(minGasBalance(perGas, getPaymentDecimals()));
      })
      .catch(() => { /* the hint just stays off */ });
    return () => { cancelled = true; };
  }, [fundOn, posting.key]);

  // What deploying costs and where it is paid. Undefined while loading.
  const [feeTerms, setFeeTerms] = useState<DeployFeeTerms | undefined>(undefined);
  const [feeTermsError, setFeeTermsError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    get<DeployFeeTerms>('/api/v1/agents/deploy-fee')
      .then((t) => { if (!cancelled) setFeeTerms(t); })
      .catch(() => { if (!cancelled) setFeeTermsError(true); });
    return () => { cancelled = true; };
  }, []);

  const feeMethod = feeTerms?.required ? feeTerms.method : null;
  const feeToken = feeTerms?.required ? (feeTerms.method === 'transfer' ? feeTerms.token : ARC_USDC_ADDRESS) : null;
  const feeRaw = feeTerms?.required && feeTerms.method === 'transfer' ? BigInt(feeTerms.amountRaw) : DEPLOY_FEE_USDC;
  const factoryAddress = (feeTerms?.required && feeTerms.factory) || ARC_AGENT_FACTORY_ADDRESS;
  // Arc has no relay: the wallet signs the fee transfer (and any funding) itself, so it must be on Arc.
  const needsArcSwitch = (feeMethod !== null || (funding && posting.key === 'arc')) && walletChainId !== null && walletChainId !== ARC_CHAIN_ID;
  // The wallets on this account. The backend counts a fee paid from these only.
  const accountWallets = [embeddedAddress, ...externalAddresses]
    .filter((a): a is string => !!a)
    .map((a) => a.toLowerCase());
  // The code of the last failed deploy, for what the page offers next.
  const [errorCode, setErrorCode] = useState<string | null>(null);

  // An Arc payment from an earlier attempt that no deploy has used yet.
  const [pendingFee, setPendingFee] = useState<string | null>(null);
  useEffect(() => {
    // A run in progress shows the fee it took instead (handleSubmit).
    if (submittingRef.current) return;
    setPendingFee(address && feeMethod === 'transfer' ? firstFreeFee(address) : null);
  }, [address, feeMethod, status]);

  // The balance of the wallet that pays, in the fee's token on the fee's
  // chain — never through the wallet's own provider, which may sit on another
  // network. Polled so funding the wallet shows up without a reload.
  const payer = walletClient?.account?.address ?? address;
  const [usdcBalance, setUsdcBalance] = useState<bigint | null>(null);
  // The fee's token, or the payment token when only funding spends.
  const balanceToken = feeToken ?? (funding ? getMarketplaceTokenAddress() : null);
  const balanceChain = feeToken ? 'arc' : posting.key;
  useEffect(() => {
    if (!payer || !balanceToken) { setUsdcBalance(null); return; }
    let cancelled = false;
    const token = new Contract(balanceToken, USDC_ABI, providerFor(balanceChain));
    const read = () => token.balanceOf(payer)
      .then((b: bigint) => { if (!cancelled) setUsdcBalance(b); })
      .catch(() => { /* RPC hiccup: keep the last reading */ });
    read();
    const timer = setInterval(read, 15_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [payer, balanceToken, balanceChain, status]);

  // Fees this run pays: one per agent, less one an earlier attempt already paid.
  const feesToPay = !feeTerms?.required ? 0 : Math.max(0, count - (feeMethod === 'transfer' && pendingFee ? 1 : 0));
  const feeNeeded = BigInt(feesToPay) * (feeRaw + ARC_GAS_MARGIN) + (funding && fundRaw ? BigInt(count) * (fundRaw + ARC_GAS_MARGIN) : 0n);
  const hasEnoughUsdc = feeNeeded === 0n || (usdcBalance !== null && usdcBalance >= feeNeeded);
  const busy = status === 'checking' || status === 'confirming' || status === 'approving' || status === 'paying' || status === 'deploying' || status === 'funding';

  useEffect(() => {
    if (!address) return; // the lookup is authenticated — deploy needs a session anyway
    const provider = form.provider;
    const request = liveListRequest({ provider, newKey: committedKey });
    if (!request) { setLive(null); setLiveStatus('idle'); return; }
    let cancelled = false;
    setLiveStatus('loading');
    authedPost<{ provider: Provider; models: ModelOption[] }>(request.path, request.body)
      .then(d => {
        if (cancelled) return;
        if (d.models.length === 0) {
          setLive(null);
          setLiveStatus('error');
          setLiveError(`${providerLabel(provider)} listed no chat models for this key — showing our defaults`);
          return;
        }
        setLive(d);
        setLiveStatus('ok');
        setLiveError('');
        // A catalog pick the provider no longer lists → its newest model. A
        // typed id stays: the deploy checks it.
        setForm(f => (customModelRef.current || d.models.some(m => m.id === f.model) ? f : { ...f, model: d.models[0].id }));
      })
      .catch((err: { code?: string; status?: number }) => {
        if (cancelled) return;
        setLive(null);
        setLiveStatus('error');
        setLiveError(liveListError(provider, err));
      });
    return () => { cancelled = true; };
  }, [form.provider, committedKey, address]);

  useEffect(() => {
    let cancelled = false;
    get<Record<string, unknown>>('/api/v1/agents/providers')
      .then((d) => {
        if (cancelled) return;
        if (d.models) setProviders(d.models as ProviderModels);
        if (d.pricing) setPricing(d.pricing as PricingMap);
      })
      .catch(() => { });
    return () => { cancelled = true; };
  }, []);

  function set(k: keyof typeof form, v: string) {
    // A key belongs to one provider — switching must never relay it to another.
    if (k === 'provider') { setCommittedKey(''); setCustomModel(false); }
    setForm(f => {
      const next = { ...f, [k]: v };
      if (k === 'provider') {
        next.model = providers[v as Provider]?.[0] ?? '';
        next.apiKey = '';
      }
      return next;
    });
  }

  // A fee from a wallet that isn't on the account is refused by the backend
  // and would be lost, by either payment method (lib/accountWallet.ts).
  // Checked before the confirm dialog and again at payment, since the wallet
  // can switch accounts while the dialog is open.
  async function unlinkedPayer(signer: JsonRpcSigner): Promise<string | null> {
    return unlinkedSignerError(await signer.getAddress(), accountWallets, "a deploy fee paid from it wouldn't count");
  }

  /**
   * Pay the fee on Arc: one USDC transfer to the treasury, signed by the
   * wallet. `onBroadcast` gets its hash the moment the wallet broadcasts it,
   * before any wait: lib/bulkDeploy saves it there, so no failure from then
   * on (a closed tab included) costs a second fee. Returns its hash.
   */
  async function payFeeOnArc(signer: JsonRpcSigner, terms: Extract<DeployFeeTerms, { method: 'transfer' }>, onBroadcast: (hash: string) => void): Promise<string> {
    const unlinked = await unlinkedPayer(signer);
    if (unlinked) throw new Error(unlinked);
    setStatus('paying');
    const data = new Interface(USDC_ABI).encodeFunctionData('transfer', [terms.recipient, BigInt(terms.amountRaw)]);
    const sent = await sendDirectPayment(signer, { to: terms.token, data }, 'arc', onBroadcast);
    console.log(`[deploy] Arc fee paid hash=${sent.hash} confirmed=${!!sent.receipt}`);
    return sent.hash;
  }

  /** Send `amount` of the payment token to an agent's wallet on the posting chain: the agent page's top-up. Returns its hash. */
  async function fundWallet(signer: JsonRpcSigner, to: string, amount: bigint): Promise<string> {
    const usdcToken = new Contract(getMarketplaceTokenAddress(), USDC_ABI, signer);
    const tx = await usdcToken.transfer.populateTransaction(to, amount);
    const sent = await signAndSendTx(signer, tx as never, undefined, { chain: posting.key });
    return sent.hash;
  }

  /** Drop a saved payment that never confirmed, so the next deploy pays anew. */
  function forgetPendingFee() {
    if (address && pendingFee) dropFee(browserFeeStorage, address, pendingFee);
    setPendingFee(address ? firstFreeFee(address) : null);
    setErrorCode(null);
    setError('');
  }

  /** Pay the fee through AgentFactory on Arc (approve, then deployAgent). Returns the factory tx hash. */
  async function payFeeViaFactory(signer: JsonRpcSigner, factoryAddr: string): Promise<string> {
    // Reads go to Arc whatever network the wallet reports. Arc has no relay:
    // the wallet signs both transactions and pays their gas in USDC. The
    // allowance is the signing wallet's: the page's owner address can be
    // another wallet on the account, whose allowance an approve never moves.
    const unlinked = await unlinkedPayer(signer);
    if (unlinked) throw new Error(unlinked);
    const arc = providerFor('arc');
    const from = await signer.getAddress();
    const readAllowance = () => new Contract(ARC_USDC_ADDRESS, USDC_ABI, arc).allowance(from, factoryAddr) as Promise<bigint>;

    // Step 1: Approve USDC spend
    setStatus('approving');
    if ((await readAllowance()) < DEPLOY_FEE_USDC) {
      const approveData = new Interface(USDC_ABI).encodeFunctionData('approve', [factoryAddr, DEPLOY_FEE_USDC]);
      const approveResult = await signAndSendTx(signer, { from, to: ARC_USDC_ADDRESS, data: approveData }, undefined, { chain: 'arc' });
      console.log(`[deploy] USDC approve done hash=${approveResult.hash}`);

      // Poll allowance until the RPC shows it
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const allowance = await readAllowance().catch(() => 0n);
        if (allowance >= DEPLOY_FEE_USDC) break;
        if (i === 19) throw new Error('USDC approve timed out — allowance not confirmed after 60s');
      }
    }

    // Step 2: Pay via AgentFactory
    setStatus('paying');
    const deployData = new Interface(AGENT_FACTORY_ABI).encodeFunctionData('deployAgent', [0]);
    const deployResult = await signAndSendTx(signer, { from, to: factoryAddr, data: deployData }, undefined, { chain: 'arc' });
    console.log(`[deploy] AgentFactory done hash=${deployResult.hash}`);
    return deployResult.hash;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!address || !feeTerms) return;
    if (!walletClient) {
      setError('Your wallet is not ready. Reconnect it and try again.');
      setErrorCode(null);
      setStatus('error');
      return;
    }
    if (feeTerms.required && feeTerms.method === 'factory' && !factoryAddress) {
      setError('AgentFactory not configured for this network');
      setErrorCode(null);
      setStatus('error');
      return;
    }
    if (submittingRef.current) return;
    submittingRef.current = true;
    setError('');
    setErrorCode(null);
    setCapacityOffer(null);
    // Frees the saved fees this run holds that no deploy used, however it ends.
    let endRun = () => {};
    const refuse = (message: unknown, code: string | null = null) => {
      endRun();
      setError(message);
      setErrorCode(code);
      setStatus('error');
      submittingRef.current = false;
    };

    const runNames = agentNames(form.name, count);
    const namesError = namesProblem(runNames);
    if (namesError) { refuse(namesError); return; }
    if (funding && fundRaw === null) { refuse(`Enter how much ${getPaymentSymbol()} to send each agent, e.g. ${DEFAULT_FUND_AMOUNT}.`); return; }

    // Before anything is paid: how many agents can start now. Read again
    // here, since other owners' agents may have taken slots since the page loaded.
    const fresh = await readCapacity();
    setCapacity(fresh);
    const room = capacityCheck(runNames.length, fresh);
    if (!room.ok) {
      setCapacityOffer(room.free > 0 ? room.free : null);
      refuse(room.message, 'AGENT_CAPACITY');
      return;
    }

    // An Arc payment no deploy has used yet, that no other tab's run holds,
    // pays for the first agent. This run holds it, and every fee it pays,
    // until it ends.
    const runId = newRunId();
    const transferFee = feeTerms.required && feeTerms.method === 'transfer';
    const savedFee = transferFee ? claimFee(browserFeeStorage, address, runId, Date.now()) : null;
    setPendingFee(savedFee);
    const heartbeat = transferFee ? setInterval(() => touchFees(browserFeeStorage, address, runId, Date.now()), FEE_HEARTBEAT_MS) : undefined;
    endRun = () => {
      endRun = () => {};
      clearInterval(heartbeat);
      releaseFees(browserFeeStorage, address, runId);
      setPendingFee(transferFee ? firstFreeFee(address) : null);
    };
    const feeCount = feeTerms.required ? runNames.length - (savedFee ? 1 : 0) : 0;

    const ownerIdentity = getOrCreateExecutorIdentity(address);
    const deployBody = {
      ownerPublicKey: ownerIdentity.publicKey,
      instructions: form.instructions,
      provider: form.provider,
      model: form.model.trim(),
      apiKey: form.apiKey,
      capabilities: [],
      tools,
      toolSecrets,
      skillSlugs,
    };

    // Before anything is paid: the checks the deploy makes (a typed model id
    // the key can't use, a bad key, …), so a refused deploy never costs a fee.
    // Once for a run of several: they differ only by name, and the longest
    // name stands for the rest.
    if ((feeTerms.required && !savedFee) || runNames.length > 1) {
      setStatus('checking');
      const longest = runNames.reduce((a, b) => (b.length > a.length ? b : a));
      try {
        await authedPost('/api/v1/agents/deploy/validate', { ...deployBody, name: longest });
      } catch (err: any) {
        refuse(err, typeof err?.code === 'string' ? err.code : null);
        return;
      }
    }

    if (feeCount > 0) {
      setStatus('idle'); // not a stale 'error' with the message cleared, while the wallet answers
      let unlinked: string | null;
      try {
        unlinked = await unlinkedPayer(await new BrowserProvider(walletClient.transport).getSigner());
      } catch {
        unlinked = 'Your wallet is not ready. Reconnect it and try again.';
      }
      if (unlinked) { refuse(unlinked); return; }
    }

    // Confirm before spending — not when nothing will be spent.
    if (feeCount > 0 || funding) {
      setStatus('confirming');
      const approved = await new Promise<boolean>((resolve) => { confirmResolveRef.current = resolve; });
      if (!approved) { endRun(); setStatus('idle'); submittingRef.current = false; return; }
    }

    setRuns(runNames.map((name) => ({ name, state: 'queued' })));
    setRunAt(0);
    try {
      const signer = await new BrowserProvider(walletClient.transport).getSigner();
      const amount = fundRaw ?? 0n;
      const outcome = await runDeploys({
        names: runNames,
        body: deployBody,
        fee: !feeTerms.required ? 'none' : feeTerms.method,
        savedFee,
        fundOn: funding ? posting : null,
        free: freeSlots(fresh),
      }, {
        payTransfer: (onBroadcast) => payFeeOnArc(signer, feeTerms as Extract<DeployFeeTerms, { method: 'transfer' }>, onBroadcast),
        payFactory: () => payFeeViaFactory(signer, factoryAddress!),
        // The backend checks the fee, creates the agent's wallet and starts it.
        deploy: (body) => authedPost<DeployedAgent>('/api/v1/agents/deploy', body),
        fund: (to) => fundWallet(signer, to, amount),
        savePendingFee: (hash) => addFee(browserFeeStorage, address, hash, runId, Date.now()),
        clearPendingFee: (hash) => dropFee(browserFeeStorage, address, hash),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        onUpdate: (i, agent) => {
          setRuns((prev) => prev.map((r, j) => (j === i ? agent : r)));
          setRunAt(i);
          if (agent.state === 'deploying') setStatus('deploying');
          else if (agent.state === 'funding') setStatus('funding');
        },
      });
      setRuns(outcome.agents);
      const made = outcome.agents.filter((a) => a.id);
      if (made.length === 0) {
        // Nothing was created: back to the form with why.
        const failed = outcome.agents.find((a) => a.state === 'failed');
        const err = failed?.error as { code?: unknown } | undefined;
        setError(failed?.error ?? 'The agent was not deployed.');
        setErrorCode(typeof err?.code === 'string' ? err.code : null);
        setStatus('error');
        return;
      }
      if (runNames.length === 1) {
        const [agent] = made;
        setDeployed({
          id: agent.id!,
          started: agent.started === true,
          feeTx: agent.feeTx ?? null,
          ogFundAddress: form.provider === '0g-compute' ? agent.walletAddress ?? null : null,
          ...(agent.fundTx ? { fundTx: agent.fundTx } : {}),
          ...(agent.fundError ? { fundError: agent.fundError } : {}),
        });
      }
      setStatus('done');
    } catch (err: any) {
      setError(err);
      setErrorCode(typeof err?.code === 'string' ? err.code : null);
      setStatus('error');
    } finally {
      endRun();
      submittingRef.current = false;
    }
  }

  if (status === 'done' && deployed) {
    const explorer = ARC_CHAIN_CONFIG.blockExplorerUrls[0];
    return (
      <div>
        <Breadcrumb items={['marketplace', 'agents', 'create', 'no-code']} />
        <div className="card-dark rounded-3xl p-10 text-center space-y-5 mt-8">
          <div className="flex items-center justify-center gap-2 text-ok">
            <Icon name="check" size={18} />
            <span className="text-sm font-semibold">Agent deployed</span>
          </div>
          <div className="space-y-1.5">
            {deployed.feeTx && (
              <div className="text-xs text-ink-3">
                Deploy fee paid on Arc · tx{' '}
                <a
                  href={`${explorer}/tx/${deployed.feeTx}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-ink-2 hover:text-ink"
                >
                  {shortHash(deployed.feeTx)}
                </a>
              </div>
            )}
            <div className="text-xs text-ink-3">
              {deployed.started
                ? 'Your agent is running.'
                : 'Your agent was created but did not start — start it from My agents.'}
            </div>
            {deployed.fundTx && (
              <div className="text-xs text-ink-3">
                Wallet funded with {fundAmount.trim()} {getPaymentSymbol()} · tx{' '}
                <a href={`${posting.explorer}/tx/${deployed.fundTx}`} target="_blank" rel="noreferrer" className="font-mono text-ink-2 hover:text-ink">
                  {shortHash(deployed.fundTx)}
                </a>
              </div>
            )}
          </div>
          {deployed.fundError != null && (
            <ErrorNotice error={deployed.fundError} title="Couldn't fund its wallet" compact className="mx-auto max-w-md text-left" />
          )}

          {deployed.ogFundAddress && (
            <div className={`mx-auto max-w-md text-left ${WARN_BOX} px-4 py-3.5 space-y-2.5`}>
              <div className="flex items-center gap-2 text-sm font-semibold text-ink">
                <Icon name="alert" size={14} className="text-warn" />
                <span>One more step: fund it with 0G</span>
              </div>
              <p className="text-xs text-ink-2 leading-relaxed">
                Send at least <span className="font-semibold text-ink">{OG_COMPUTE_START_0G} 0G</span> on the 0G chain to the
                agent's wallet. {OG_COMPUTE_ACCOUNT_0G} 0G opens its 0G Compute account; it takes no task until then.
              </p>
              <div className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2">
                <span className="font-mono text-xs text-ink break-all">{deployed.ogFundAddress}</span>
                <CopyButton text={deployed.ogFundAddress} />
              </div>
              <p className="text-[11px] text-ink-3">The agent's page shows when it starts taking tasks.</p>
            </div>
          )}

          {privateSkillSlugs.length > 0 && (
            <div className="mx-auto max-w-md text-left space-y-1">
              <div className="text-xs font-medium text-ink-2">Private skills still to attach</div>
              {privateSkillSlugs.map((slug) => (
                <div key={slug} className="flex items-start gap-2 text-xs text-ink-3">
                  <Icon name="clock" size={12} className="mt-0.5 shrink-0" />
                  <span className="min-w-0 break-words">
                    <span className="font-mono">{slug}</span> — add this from the agent's
                    Skills panel. Private skills can't be installed at deploy.
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="flex justify-center gap-3 flex-wrap pt-1">
            {deployed.ogFundAddress ? (
              <Button variant="primary" label="Open agent" onClick={() => navigate(`/agents/${deployed.id}`)} />
            ) : (
              <Button variant="primary" label="My agents" onClick={() => navigate('/agents/mine')} />
            )}
            <Button
              variant="ghost"
              label="Deploy another"
              onClick={() => { setStatus('idle'); setDeployed(null); setRuns([]); setPrivateSkillSlugs([]); }}
            />
          </div>
          </div>
        </div>
    );
  }

  if (status === 'done' && runs.length > 1) {
    const explorer = ARC_CHAIN_CONFIG.blockExplorerUrls[0];
    const made = runs.filter((r) => r.id);
    const ogWallets = form.provider === '0g-compute' ? made.filter((r) => r.walletAddress) : [];
    return (
      <div>
        <Breadcrumb items={['marketplace', 'agents', 'create', 'no-code']} />
        <div className="card-dark rounded-3xl p-6 sm:p-10 space-y-5 mt-8">
          <div className="flex items-center justify-center gap-2 text-ok">
            <Icon name="check" size={18} />
            <span className="text-sm font-semibold">
              {made.length === runs.length ? `${made.length} agents deployed` : `${made.length} of ${runs.length} agents deployed`}
            </span>
          </div>
          {made.length < runs.length && (
            <p className="text-center text-xs text-ink-3">The run stopped at the first problem. Agents already deployed stay; nothing more was paid.</p>
          )}

          <ul className="divide-y divide-line rounded-xl border border-line">
            {runs.map((r) => (
              <li key={r.name} className="px-4 py-3 space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-sm font-medium text-ink">{r.name}</span>
                  {r.id ? (
                    <Link to={`/agents/${r.id}`} className="text-xs text-ink-2 hover:text-ink">Open agent →</Link>
                  ) : (
                    <span className={`text-xs ${r.state === 'failed' ? 'text-err' : 'text-ink-3'}`}>{RUN_STATE_LABEL[r.state]}</span>
                  )}
                </div>
                {r.id && (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
                    <span className={r.started ? 'text-ok' : 'text-warn'}>{r.started ? 'Running' : 'Created, not started — start it from My agents'}</span>
                    {r.walletAddress && (
                      <span className="flex items-center gap-1">
                        <span className="font-mono text-ink-2">{shortAddress(r.walletAddress)}</span>
                        <CopyButton text={r.walletAddress} what="wallet address" />
                      </span>
                    )}
                    {r.feeTx && (
                      <a href={`${explorer}/tx/${r.feeTx}`} target="_blank" rel="noreferrer" className="hover:text-ink">
                        fee tx <span className="font-mono">{shortHash(r.feeTx)}</span>
                      </a>
                    )}
                    {r.fundTx && (
                      <a href={`${posting.explorer}/tx/${r.fundTx}`} target="_blank" rel="noreferrer" className="hover:text-ink">
                        funded <span className="font-mono">{shortHash(r.fundTx)}</span>
                      </a>
                    )}
                  </div>
                )}
                {/* The fee this agent paid before it failed: the next deploy uses it if it can still pay. */}
                {!r.id && r.feeTx && (
                  <div className="text-xs text-ink-3">
                    <a href={`${explorer}/tx/${r.feeTx}`} target="_blank" rel="noreferrer" className="hover:text-ink">
                      fee tx <span className="font-mono">{shortHash(r.feeTx)}</span>
                    </a>
                  </div>
                )}
                {r.state === 'failed' && r.error != null && <ErrorNotice error={r.error} title="Couldn't deploy this agent" compact />}
                {r.fundError != null && <ErrorNotice error={r.fundError} title="Couldn't fund its wallet" compact />}
              </li>
            ))}
          </ul>

          {ogWallets.length > 0 && (
            <div className={`text-left ${WARN_BOX} px-4 py-3.5 space-y-2.5`}>
              <div className="flex items-center gap-2 text-sm font-semibold text-ink">
                <Icon name="alert" size={14} className="text-warn" />
                <span>One more step: fund each with 0G</span>
              </div>
              <p className="text-xs text-ink-2 leading-relaxed">
                Send at least <span className="font-semibold text-ink">{OG_COMPUTE_START_0G} 0G</span> on the 0G chain to each
                agent's wallet. {OG_COMPUTE_ACCOUNT_0G} 0G opens its 0G Compute account; it takes no task until then.
              </p>
              {ogWallets.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2">
                  <span className="min-w-0 text-xs text-ink-3 truncate">{r.name}</span>
                  <span className="flex items-center gap-1">
                    <span className="font-mono text-xs text-ink break-all">{r.walletAddress}</span>
                    <CopyButton text={r.walletAddress!} />
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="flex justify-center gap-3 flex-wrap pt-1">
            <Button variant="primary" label="My agents" onClick={() => navigate('/agents/mine')} />
            <Button
              variant="ghost"
              label="Deploy more"
              onClick={() => { setStatus('idle'); setDeployed(null); setRuns([]); setPrivateSkillSlugs([]); }}
            />
          </div>
        </div>
      </div>
    );
  }

  // A run of several, or one with its wallet funded, says what each step
  // costs; a single deploy keeps the words it always had.
  const plain = count === 1 && !funding;
  const fundingChain = posting.key === 'arc' ? 'Arc' : posting.label;
  const symbol = getPaymentSymbol();
  const fundText = fundRaw ? formatUnits(fundRaw, getPaymentDecimals()) : fundAmount.trim();
  const times = (n: number, each: string, total: string) => (n === 1 ? `${each} USDC` : `${n} × ${each} = ${total} USDC`);
  const feeSignatures = !feeTerms?.required ? 0 : feeTerms.method === 'transfer' ? feesToPay : 2 * count;
  const signatures = feeSignatures + (funding ? count : 0);
  const signingSummary = plain
    ? feeTerms?.required && feeTerms.method === 'transfer'
      ? 'Your wallet signs one USDC transfer on Arc.'
      : 'Your wallet signs two transactions on Arc: a USDC approval, then the deploy through AgentFactory.'
    : `Your wallet signs ${signatures} transaction${signatures === 1 ? '' : 's'}: ${[
      feeTerms?.required && feeTerms.method === 'transfer' && feesToPay > 0
        ? `${feesToPay === 1 ? 'one deploy fee transfer' : `${feesToPay} deploy fee transfers, one per agent`} on Arc`
        : null,
      feeTerms?.required && feeTerms.method === 'factory'
        ? `a USDC approval and an AgentFactory payment for ${count === 1 ? 'the agent' : 'each agent'} on Arc`
        : null,
      funding
        ? `${count === 1 ? `one ${symbol} transfer to its wallet` : `${count} ${symbol} transfers, one to each agent's wallet`} on ${fundingChain}, after ${count === 1 ? 'it deploys' : 'that agent deploys'}`
        : null,
    ].filter(Boolean).join(', and ')}.`;
  const runningLabel = count > 1 ? `Deploying ${Math.min(runAt + 1, count)} of ${count}…` : null;

  return (
    <div>
      <Breadcrumb items={['marketplace', 'agents', 'create', 'no-code']} />
      <PageHeader title="Create an agent." titleMuted="No code needed." description="Once running, it picks up and completes tasks on its own." />

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* 01 — Identity */}
        <div className="card-dark rounded-3xl p-6 sm:p-8">
          <SectionRule num="01" title="Identity" />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            <FormField label="Agent name" required className="min-w-0">
              <FormInput
                required
                value={form.name}
                onChange={e => set('name', e.target.value)}
                placeholder="research-agent"
              />
            </FormField>
            <FormField label="Owner wallet" className="min-w-0">
              <div className="w-full rounded-lg px-3 py-2.5 bg-surface-2 border border-line text-ink-3 text-sm font-mono truncate">
                {address ?? 'Connect wallet'}
              </div>
            </FormField>
          </div>
          <FormField
            label="How many agents"
            className="mt-5"
            hint={free !== null
              ? free === 0
                ? capacity?.memory?.slotsFree === 0 && capacity.poolFree > 0 && capacity.ownerFree > 0
                  ? 'No agent can start now: the server is low on memory. Try again later.'
                  : 'No agent can start now. Stop one of your agents first.'
                : `You can start ${free} now.`
              : undefined}
          >
            <div className="w-28">
              <FormInput
                type="number"
                inputMode="numeric"
                min={1}
                max={Math.max(1, maxCount)}
                step={1}
                value={count}
                onChange={(e) => {
                  const n = Math.floor(Number(e.target.value));
                  setCount(Number.isFinite(n) ? Math.min(Math.max(1, maxCount), Math.max(1, n)) : 1);
                }}
                className="font-mono"
                aria-label="How many agents"
              />
            </div>
          </FormField>
          {count > 1 && form.name.trim() && (
            <p className="mt-2 text-xs text-ink-3 leading-relaxed">
              Named <span className="font-mono text-ink-2">{names[0]}</span> to <span className="font-mono text-ink-2">{names[names.length - 1]}</span>.
              {' '}Put <span className="font-mono">{'{n}'}</span> in the name to place the number.
            </p>
          )}
          <FormField label="Instructions" required className="mt-5">
            <div className="rounded-lg border border-line divide-y divide-line focus-within:border-line-2 transition-colors">
              <div className="flex text-xs items-stretch">
                <div className="relative ml-auto">
                  <button type="button" data-tmpl-btn onClick={() => setShowTemplateMenu(!showTemplateMenu)}
                    aria-label="Instruction templates"
                    className="px-3 py-1.5 text-ink-3 hover:text-ink transition-colors text-sm leading-none block">
                    ☰
                  </button>
                  {showTemplateMenu && (
                    <div className="absolute right-0 top-full z-10 w-48 overflow-hidden rounded-xl border border-line bg-surface-2 shadow-lg">
                      <div className="px-3 py-1.5 text-[11px] text-ink-3 border-b border-line">Templates</div>
                      {Object.entries(INSTRUCTION_TEMPLATES).map(([key, val]) => (
                        <button key={key} type="button" data-tmpl-btn onClick={() => { set('instructions', val); setShowTemplateMenu(false); }}
                          className="block w-full text-left px-3 py-1.5 text-xs text-ink-2 hover:bg-surface transition-colors">
                          {key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase())}
                        </button>
                      ))}
                      <div className="border-t border-line">
                        <button type="button" data-tmpl-btn onClick={() => { set('instructions', ''); setShowTemplateMenu(false); }}
                          className="block w-full text-left px-3 py-1.5 text-xs text-err hover:bg-surface transition-colors">
                          Clear
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
              <textarea
                required
                rows={10}
                value={form.instructions}
                onChange={e => set('instructions', e.target.value)}
                placeholder="Describe what this agent does, how it should behave, and what tasks it should pick up."
                className="w-full rounded-b-lg px-3 py-2.5 bg-surface-2 text-ink text-sm resize-y leading-relaxed font-mono border-0 outline-none"
              />
            </div>
          </FormField>
        </div>

        {/* 02 — Model */}
        <div className="card-dark rounded-3xl p-6 sm:p-8">
          <SectionRule num="02" title="Model" />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
            <FormField label="Provider">
              <FormSelect value={form.provider} onChange={e => set('provider', e.target.value)}>
                {Object.keys(providers).map(p => <option key={p} value={p}>{providerLabel(p)}</option>)}
              </FormSelect>
            </FormField>
            <FormField
              label="Model"
              hint={
                customModel ? `Checked against ${providerName}'s model list with your key when you deploy, before any fee.`
                : liveStatus === 'loading' ? 'Checking which models this key can use…'
                : liveStatus === 'ok' && live ? `Live from ${providerName} · ${live.models.length} models, newest first`
                : liveStatus === 'error' ? liveError
                : form.provider === '0g-compute' ? undefined
                : !address ? 'Connect a wallet to list the models your key can use.'
                : 'Paste your API key to list every model it can use.'
              }
            >
              {customModel ? (
                <div className="flex items-center gap-2">
                  <FormInput
                    required
                    autoFocus
                    value={form.model}
                    onChange={e => set('model', e.target.value)}
                    placeholder="Model id, exactly as the provider names it"
                    className="font-mono"
                    maxLength={128}
                    aria-label="Custom model id"
                  />
                  <button
                    type="button"
                    onClick={() => { setCustomModel(false); set('model', modelOptions[0]?.id ?? ''); }}
                    className="shrink-0 text-xs text-ink-3 hover:text-ink"
                  >
                    List
                  </button>
                </div>
              ) : (
                <FormSelect
                  value={form.model}
                  onChange={e => {
                    if (e.target.value === CUSTOM_MODEL) { setCustomModel(true); set('model', ''); } else set('model', e.target.value);
                  }}
                  className="font-mono"
                >
                  {modelOptions.map(m => <option key={m.id} value={m.id}>{modelLabel(m)}</option>)}
                  {isKeyed(form.provider) && <option value={CUSTOM_MODEL}>Custom model id…</option>}
                </FormSelect>
              )}
            </FormField>
            <FormField label="API key" required={form.provider !== '0g-compute'} hint={form.provider === '0g-compute' ? "No API key needed — the agent's wallet pays a 0G Compute provider" : undefined}>
              <FormInput
                required={form.provider !== '0g-compute'}
                type="password"
                className={`font-mono ${form.provider === '0g-compute' ? 'opacity-40' : ''}`}
                value={form.apiKey}
                onChange={e => set('apiKey', e.target.value)}
                onBlur={e => setCommittedKey(e.target.value.trim())}
                onPaste={e => { const el = e.currentTarget; setTimeout(() => setCommittedKey(el.value.trim()), 0); }}
                placeholder={form.provider === '0g-compute' ? 'Auto — uses agent wallet' : 'sk-...'}
                disabled={form.provider === '0g-compute'}
              />
            </FormField>
          </div>

          {/* Model pricing display */}
          {isPriced(currentModel) ? (
            <div className="mt-3 flex items-center gap-4 text-[12px] text-ink-3">
              <span>
                Input: <span className="font-mono text-ink">{usdPer1M(currentModel.inputCostPer1M)}</span> / 1M tokens
              </span>
              <span>
                Output: <span className="font-mono text-ink">{usdPer1M(currentModel.outputCostPer1M)}</span> / 1M tokens
              </span>
              <span className="text-ink-3">
                ~${((currentModel.inputCostPer1M + currentModel.outputCostPer1M) / 2).toFixed(2)} avg / 1M
              </span>
            </div>
          ) : form.model.trim() && (customModel || (live && live.provider === form.provider)) ? (
            <div className="mt-3 text-[12px] text-ink-3">
              Price not listed for <span className="font-mono text-ink">{form.model.trim()}</span> — check {providerName}'s pricing page.
            </div>
          ) : null}

          {count > 1 && form.provider !== '0g-compute' && (
            <p className="mt-3 text-[12px] text-ink-3">
              All {count} agents use your one {providerName} key, so they share its rate limits and its bill.
            </p>
          )}

          {form.provider === '0g-compute' && (
            <div className="mt-4 rounded-xl border border-line-2 bg-surface-2 px-4 py-3.5 text-[13px] leading-relaxed space-y-2">
              <div className="flex items-center gap-2 font-semibold text-ink">
                <Icon name="bolt" size={14} />
                <span>0G Compute — billed to agent wallet</span>
              </div>
              <div className="text-ink-2 space-y-1">
                <p>
                  Inference is billed to the agent's own wallet, which pays the
                  0G Compute ledger directly.
                </p>
              </div>
              <div className="border-t border-line pt-2.5 space-y-1">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-ink">Fund before its first task</span>
                  <span className="font-mono text-ink shrink-0">{OG_COMPUTE_START_0G} 0G</span>
                </div>
                <p className="text-ink-3 text-[12px]">
                  After you deploy, send it to the agent's wallet on the 0G chain: {OG_COMPUTE_ACCOUNT_0G} 0G opens
                  its 0G Compute account and the rest pays gas. It won't take tasks until then.
                </p>
                {count > 1 && (
                  <p className="text-ink-3 text-[12px]">
                    Each of the {count} agents needs its own account: {OG_COMPUTE_START_0G} 0G to each wallet.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 03 — Skills */}
        <div className="card-dark rounded-3xl p-6 sm:p-8">
          <SectionRule num="03" title="Skills" side="Optional" />
          <FormField
            label="Install skills"
            hint="Reusable bundles of instructions + tools. Import from the open SKILL.md ecosystem or the registry — they shape how this agent actually works."
          >
            <SkillPicker
              selectedSlugs={skillSlugs}
              onChange={(slugs) => {
                setSkillSlugs(slugs);
              }}
              secrets={toolSecrets}
              onSecretsChange={setToolSecrets}
              onImported={(slug, isPublic) => {
                if (!isPublic) setPrivateSkillSlugs((p) => (p.includes(slug) ? p : [...p, slug]));
              }}
            />
          </FormField>
        </div>

        {/* 04 — Tools & MCP servers */}
        <div className="card-dark rounded-3xl p-6 sm:p-8">
          <SectionRule num="04" title="Tools & MCP servers" side="Optional" />
          <ToolManager tools={tools} onChange={setTools} secrets={toolSecrets} onSecretsChange={setToolSecrets} />
        </div>

        {/* Deploy */}
        <div className="card-dark rounded-3xl p-6 sm:p-8">
          {!address ? (
            <p className="text-sm text-ink-3">Connect a wallet to deploy an agent.</p>
          ) : feeTermsError ? (
            <p className="text-sm text-err">Could not load the deploy fee. Reload the page to try again.</p>
          ) : !feeTerms ? (
            <p className="text-sm text-ink-3">Loading the deploy fee…</p>
          ) : needsArcSwitch ? (
            <div className="flex items-center gap-3 flex-wrap">
              <p className="text-sm text-ink-3">
                {feeMethod !== null ? 'The deploy fee is paid on Arc' : 'Funding is sent on Arc'}, and your wallet is on another network.
              </p>
              <Button type="button" variant="ghost" label="Switch to Arc" onClick={() => { void switchChain(ARC_CHAIN_ID); }} />
            </div>
          ) : (
            <>
              {fundingOffered && (
                <div className="mb-4 rounded-xl border border-line bg-surface-2 px-4 py-3.5 space-y-2">
                  <label className="flex items-center gap-2.5 text-sm text-ink">
                    <input
                      type="checkbox"
                      checked={fundOn}
                      onChange={(e) => setFundOn(e.target.checked)}
                      disabled={busy}
                      className="w-3.5 h-3.5 accent-cream"
                    />
                    <span>{count === 1 ? "Fund the agent's wallet" : "Fund each agent's wallet"}</span>
                  </label>
                  {fundOn ? (
                    <>
                      <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
                        <span>Send</span>
                        <div className="w-24">
                          <FormInput
                            value={fundAmount}
                            onChange={(e) => setFundAmount(e.target.value)}
                            inputMode="decimal"
                            disabled={busy}
                            className="font-mono"
                            aria-label={`${symbol} to send each agent`}
                          />
                        </div>
                        <span>{symbol} on {fundingChain} to {count === 1 ? 'it' : 'each one'} after it deploys.</span>
                      </div>
                      {fundRaw === null ? (
                        <p className="text-[12px] text-err">Enter an amount above 0.</p>
                      ) : minGasRaw !== null ? (
                        <p className="text-[12px] text-ink-3">
                          One transaction can cost up to {formatMinGas(minGasRaw, getPaymentDecimals())} {symbol} at current gas prices. An agent takes no task below that.
                        </p>
                      ) : null}
                    </>
                  ) : (
                    <p className="text-[12px] text-ink-3">An agent pays its own gas. Fund it here as it deploys, or later from its page.</p>
                  )}
                </div>
              )}

              {feeTerms.required && (
                <div className="mb-4 rounded-xl border border-line bg-surface-2 px-4 py-3.5 space-y-2">
                  <div className="flex items-center gap-2 text-sm font-semibold text-ink">
                    <Icon name="bolt" size={15} className="text-accent" />
                    <span>
                      {plain
                        ? feeTerms.method === 'transfer' ? 'Deployment uses 1 signature' : 'Deployment uses 2 signatures'
                        : `Deployment uses ${signatures} signature${signatures === 1 ? '' : 's'}`}
                    </span>
                  </div>
                  {feeTerms.method === 'transfer' ? (
                    <p className="text-[13px] text-ink-2 leading-relaxed">
                      {count === 1
                        ? `Sends the ${usdc(feeRaw)} USDC deploy fee to the platform treasury on Arc.`
                        : `Sends the ${usdc(feeRaw)} USDC deploy fee for each agent to the platform treasury on Arc: ${times(feesToPay, usdc(feeRaw), usdc(feeRaw * BigInt(feesToPay)))}.`}
                      {' '}Gas is paid in USDC from the same balance.
                    </p>
                  ) : (
                    <ol className="text-[13px] text-ink-2 leading-relaxed space-y-1 list-decimal list-inside">
                      <li>Approve USDC — allows AgentFactory to charge the deploy fee.</li>
                      <li>
                        {count === 1
                          ? `Deploy agent — pays ${usdc(feeRaw)} USDC, emits on-chain event.`
                          : `Deploy each agent — pays ${usdc(feeRaw)} USDC, emits on-chain event: ${times(count, usdc(feeRaw), usdc(feeRaw * BigInt(count)))}.`}
                      </li>
                    </ol>
                  )}
                  {pendingFee ? (
                    <div className="text-[13px] text-ink-3 pt-0.5">
                      Fee already paid (tx{' '}
                      <a
                        href={`${ARC_CHAIN_CONFIG.blockExplorerUrls[0]}/tx/${pendingFee}`}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-ink-2 hover:text-ink"
                      >
                        {shortHash(pendingFee)}
                      </a>) — {count === 1 ? 'deploying uses it' : 'the first agent uses it'}, with no new charge.
                      {errorCode === 'DEPLOY_FEE_NOT_FOUND' && (
                        <>
                          {' '}If the explorer never shows it,{' '}
                          <button type="button" onClick={forgetPendingFee} className="text-ink-2 underline hover:text-ink">
                            forget this payment
                          </button>{' '}
                          and pay again.
                        </>
                      )}
                    </div>
                  ) : (
                    <div className="text-[13px] text-ink-3 pt-0.5">
                      Paid from <span className="font-mono text-ink-2">{payer ? shortAddress(payer) : '…'}</span>
                      {' · '}balance on Arc{' '}
                      <span className="font-mono text-ink-2">
                        {usdcBalance !== null ? `${Number(formatUnits(usdcBalance, 6)).toFixed(2)} USDC` : '…'}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {!hasEnoughUsdc && usdcBalance !== null && (
                <div className="mb-4 rounded-xl border border-[color:color-mix(in_srgb,var(--bb-err)_40%,transparent)] bg-[color:color-mix(in_srgb,var(--bb-err)_6%,transparent)] px-4 py-3.5 text-[13px] text-ink-2 leading-relaxed space-y-1.5">
                  <div className="flex items-center gap-2 font-semibold text-err">
                    <Icon name="bolt" size={15} />
                    <span>Not enough USDC to deploy</span>
                  </div>
                  <p>
                    You need at least <span className="font-mono">{usdc(feeNeeded)} USDC</span>
                    {plain
                      ? ` on Arc — the ${usdc(feeRaw)} USDC fee plus a little for gas.`
                      : ` on ${fundingChain}: ${[
                        feesToPay > 0 ? `${times(feesToPay, usdc(feeRaw), usdc(feeRaw * BigInt(feesToPay)))} in deploy fees` : null,
                        funding && fundRaw ? `${times(count, fundText, usdc(fundRaw * BigInt(count)))} for the agents' wallets` : null,
                      ].filter(Boolean).join(' and ')}, plus a little for gas.`}
                  </p>
                </div>
              )}

              <div className="flex items-center gap-3 flex-wrap">
                <Button
                  type="submit"
                  variant="primary"
                  disabled={busy || !hasEnoughUsdc || (funding && fundRaw === null)}
                  label={
                    status === 'checking'
                      ? 'Checking…'
                      : status === 'confirming'
                      ? 'Confirm deploy…'
                      : runningLabel && (status === 'approving' || status === 'paying' || status === 'deploying' || status === 'funding')
                      ? runningLabel
                      : status === 'approving'
                      ? 'Approving USDC…'
                      : status === 'paying'
                      ? 'Paying deploy fee…'
                      : status === 'deploying'
                      ? 'Creating agent…'
                      : status === 'funding'
                      ? 'Funding wallet…'
                      : count > 1
                      ? feesToPay > 0
                        ? `Deploy ${count} agents (${usdc(feeRaw * BigInt(feesToPay))} USDC) →`
                        : `Deploy ${count} agents →`
                      : !feeTerms.required || pendingFee
                      ? 'Deploy agent →'
                      : `Deploy agent (${usdc(feeRaw)} USDC) →`
                  }
                />
              </div>

              {count > 1 && runs.length > 1 && busy && (
                <ul className="mt-4 divide-y divide-line rounded-xl border border-line text-[13px]">
                  {runs.map((r) => (
                    <li key={r.name} className="flex items-center justify-between gap-3 px-4 py-2">
                      <span className="min-w-0 truncate text-ink-2">{r.name}</span>
                      <span className={`shrink-0 text-xs ${r.state === 'done' ? 'text-ok' : r.state === 'failed' ? 'text-err' : 'text-ink-3'}`}>
                        {RUN_STATE_LABEL[r.state]}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          {status === 'error' && (
            <>
              <ErrorNotice error={error} title={count > 1 ? "Couldn't deploy the agents" : "Couldn't deploy the agent"} className="mt-3" />
              {capacityOffer !== null && (
                <div className="mt-3">
                  <Button
                    type="button"
                    variant="ghost"
                    label={capacityOffer === 1 ? 'Deploy 1 agent instead' : `Deploy ${capacityOffer} agents instead`}
                    onClick={() => { setCount(capacityOffer); setCapacityOffer(null); setStatus('idle'); setError(''); }}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </form>
      <ConfirmDialog
        open={status === 'confirming'}
        title={count === 1 ? 'Deploy agent' : `Deploy ${count} agents`}
        description={
          <div className="space-y-2">
            <p className="text-sm text-ink-2">Review before deploying:</p>
            <div className="rounded-lg bg-surface-2 p-3 space-y-1.5 font-mono text-xs">
              {count > 1 && (
                <div className="flex justify-between gap-3">
                  <span className="text-ink-3">Agents</span>
                  <span>{count}</span>
                </div>
              )}
              {feeTerms?.required && (
                <div className="flex justify-between gap-3">
                  <span className="text-ink-3">Deploy fee</span>
                  <span className="text-right">
                    {feesToPay === 0
                      ? 'already paid'
                      : times(feesToPay, usdc(feeRaw), usdc(feeRaw * BigInt(feesToPay)))}
                    {feesToPay > 0 && feesToPay < count ? ' (one already paid)' : ''}
                  </span>
                </div>
              )}
              {funding && fundRaw ? (
                <div className="flex justify-between gap-3">
                  <span className="text-ink-3">{count === 1 ? 'Wallet funding' : 'Funding, each wallet'}</span>
                  <span className="text-right">
                    {count === 1 ? `${fundText} ${symbol}` : `${count} × ${fundText} = ${formatUnits(fundRaw * BigInt(count), getPaymentDecimals())} ${symbol}`}
                  </span>
                </div>
              ) : null}
              <div className="flex justify-between gap-3">
                <span className="text-ink-3">Paid from</span>
                <span>{payer ? shortAddress(payer) : '…'}</span>
              </div>
              {feeTerms?.required && feeTerms.method === 'transfer' && feesToPay > 0 && (
                <div className="flex justify-between gap-3">
                  <span className="text-ink-3">Paid to</span>
                  <span>treasury {feeTerms.recipient.slice(0, 6)}…{feeTerms.recipient.slice(-4)}</span>
                </div>
              )}
              <div className="flex justify-between gap-3">
                <span className="text-ink-3">Gas (paid in USDC)</span>
                <span>{signatures > 1 && !plain ? 'under 0.01 USDC each' : 'under 0.01 USDC'}</span>
              </div>
            </div>
            <p className="text-xs text-ink-3">{signingSummary}</p>
          </div>
        }
        confirmLabel="Confirm deploy"
        onConfirm={() => confirmResolveRef.current?.(true)}
        onCancel={() => confirmResolveRef.current?.(false)}
      />
    </div>
  );
}
