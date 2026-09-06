import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWalletClient, useChainId } from 'wagmi';
import { BrowserProvider, Contract, formatUnits } from 'ethers';
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
} from '../components/bb';
import { ToolManager, type AnyTool } from '../components/bb/ToolManager';
import SkillPicker from '../components/bb/SkillPicker';
import { get, authedPost } from '../lib/api';
import { signAndSendTx } from '../lib/txSigner';
import { useChainAddress } from '../hooks/useChainWallet';
import { getOrCreateExecutorIdentity } from '../lib/executorIdentity';
import { BASE_CHAIN_ID, MARKETPLACE_TOKEN_ADDRESS, unsetIfZero } from '../config/constants';
import { CONTRACT_ADDRESSES } from '../config/contractAddresses';
import { isMainnet } from '../config/constants';

// AgentFactory on Base — accepts USDC, emits AgentDeployed event
const AGENT_FACTORY_ABI = [
  'function deployAgent(uint256 usdcAmount) external',
  'function getTotalCost(uint256 usdcAmount) external view returns (uint256)',
  'function deployFeeUsdc() external view returns (uint256)',
];

const USDC_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address owner) external view returns (uint256)',
];

const AGENT_FACTORY_ADDRESS = unsetIfZero(
  isMainnet
    ? (CONTRACT_ADDRESSES.base as any)?.agentFactory
    : CONTRACT_ADDRESSES.baseTestnet?.agentFactory,
);

// Deploy fee: 1 USDC (6 decimals)
const DEPLOY_FEE_USDC = 1_000_000n;
const DEPLOY_FEE_HUMAN = 1;

type Provider = 'openai' | 'anthropic' | 'groq' | 'gemini' | '0g-compute';
type ProviderModels = Record<Provider, string[]>;
interface ModelPricing { id: string; inputCostPer1M: number; outputCostPer1M: number; }
type PricingMap = Record<Provider, ModelPricing[]>;

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
  const chainId = useChainId();
  const navigate = useNavigate();

  const [providers, setProviders] = useState<ProviderModels>({
    openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'o3', 'o3-mini'],
    anthropic: ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-opus-4-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5'],
    groq: ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'qwen3-32b', 'gpt-oss-120b', 'gpt-oss-20b'],
    gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
    '0g-compute': ['deepseek-ai/DeepSeek-V3.1', 'qwen/qwen-2.5-7b-instruct', 'google/gemma-3-27b-it'],
  });
  const [pricing, setPricing] = useState<PricingMap>({} as PricingMap);

  const [form, setForm] = useState({
    name: '',
    instructions: '',
    provider: '0g-compute' as Provider,
    model: 'deepseek-ai/DeepSeek-V3.1',
    apiKey: '',
  });

  // Lookup current model's pricing
  const currentModelPricing = pricing[form.provider]?.find(m => m.id === form.model);

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
  // now happens on-chain and the backend creates the agent from the event, so
  // there is no agent id here to attach them to — they're listed on the success
  // screen for the owner to install from the agent's Skills panel instead.
  const [privateSkillSlugs, setPrivateSkillSlugs] = useState<string[]>([]);

  const [status, setStatus] = useState<'idle' | 'confirming' | 'approving' | 'deploying' | 'done' | 'error'>('idle');
  const submittingRef = useRef(false);
  const confirmResolveRef = useRef<((approve: boolean) => void) | null>(null);
  const [error, setError] = useState('');
  const [deployTxHash, setDeployTxHash] = useState('');

  const isBaseChain = chainId === BASE_CHAIN_ID;
  const needsChainSwitch = !isBaseChain && chainId !== 0;

  const [usdcBalance, setUsdcBalance] = useState<bigint | null>(null);

  // Load USDC balance
  useEffect(() => {
    if (!address || !walletClient) return;
    const provider = new BrowserProvider(walletClient.transport);
    const usdc = new Contract(MARKETPLACE_TOKEN_ADDRESS, USDC_ABI, provider);
    usdc.balanceOf(address).then((b: bigint) => setUsdcBalance(b)).catch(() => {});
  }, [address, walletClient, status]);

  const usdcBalanceHuman = usdcBalance !== null ? Number(formatUnits(usdcBalance, 6)) : null;
  const hasEnoughUsdc = usdcBalanceHuman !== null && usdcBalanceHuman >= DEPLOY_FEE_HUMAN;

  const [ogPricing, setOgPricing] = useState<Record<string, { promptUsd: string; completionUsd: string } | null>>({});

  useEffect(() => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    fetch('https://router-api.0g.ai/v1/models', { signal: ctrl.signal })
      .then(r => r.json())
      .then(res => {
        const routerModels = (res.data || []) as Array<{ id: string; pricing_usd?: { prompt: string; completion: string } }>;
        const map: Record<string, { promptUsd: string; completionUsd: string } | null> = {};
        for (const modelId of (providers['0g-compute'] ?? [])) {
          const parts = modelId.toLowerCase().split(/[/\-_.]+/).filter(Boolean);
          let best: { id: string; score: number; promptUsd: string; completionUsd: string } | null = null;
          for (const rm of routerModels) {
            const rid = rm.id.toLowerCase();
            const score = parts.reduce((s, p) => s + (rid.includes(p) ? 1 : 0), 0);
            if (score > (best?.score ?? -1) && rm.pricing_usd) {
              best = { id: rm.id, score, promptUsd: rm.pricing_usd.prompt, completionUsd: rm.pricing_usd.completion };
            }
          }
          map[modelId] = best ? { promptUsd: best.promptUsd, completionUsd: best.completionUsd } : null;
        }
        setOgPricing(map);
      })
      .catch(() => {});
    return () => { clearTimeout(t); ctrl.abort(); };
  }, []);

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
    setForm(f => {
      const next = { ...f, [k]: v };
      if (k === 'provider') next.model = providers[v as Provider]?.[0] ?? '';
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!address) return;
    if (!walletClient) return;
    if (!AGENT_FACTORY_ADDRESS) {
      setError('AgentFactory not configured for this network');
      return;
    }
    if (submittingRef.current) return;
    submittingRef.current = true;
    setError('');

    // Show confirmation dialog before spending
    setStatus('confirming');
    const approved = await new Promise<boolean>((resolve) => { confirmResolveRef.current = resolve; });
    if (!approved) { setStatus('idle'); submittingRef.current = false; return; }

    try {
      const provider = new BrowserProvider(walletClient.transport);
      const signer = await provider.getSigner();

      // Step 1: Approve USDC spend (relayed — gas paid in USDC)
      setStatus('approving');
      const usdc = new Contract(MARKETPLACE_TOKEN_ADDRESS, USDC_ABI, provider);
      const currentAllowance = await usdc.allowance(address, AGENT_FACTORY_ADDRESS);
      if (currentAllowance < DEPLOY_FEE_USDC) {
        const approveTx = await usdc.approve.populateTransaction(AGENT_FACTORY_ADDRESS, DEPLOY_FEE_USDC);
        const approveResult = await signAndSendTx(signer, approveTx as any);
        console.log(`[deploy] USDC approve relay done hash=${approveResult.hash} userOp=${approveResult.userOp ?? false}`);

        // Poll allowance until on-chain — UserOps can take several blocks
        console.log(`[deploy] Waiting for USDC allowance to be confirmed on-chain...`);
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 3000));
          const fresh = new Contract(MARKETPLACE_TOKEN_ADDRESS, USDC_ABI, provider);
          const allowance = await fresh.allowance(address, AGENT_FACTORY_ADDRESS);
          if (allowance >= DEPLOY_FEE_USDC) {
            console.log(`[deploy] USDC allowance confirmed: ${allowance}`);
            break;
          }
          if (i === 19) throw new Error('USDC approve timed out — allowance not confirmed after 60s');
        }
      }

      // Step 2: Pay via AgentFactory (relayed — gas paid in USDC)
      setStatus('deploying');
      const factory = new Contract(AGENT_FACTORY_ADDRESS, AGENT_FACTORY_ABI, provider);
      const deployTx = await factory.deployAgent.populateTransaction(0);
      const deployResult = await signAndSendTx(signer, deployTx as any);
      console.log(`[deploy] AgentFactory relay done hash=${deployResult.hash} userOp=${deployResult.userOp ?? false}`);
      if (deployResult.userOp) {
        await new Promise(r => setTimeout(r, 15000));
      }
      setDeployTxHash(deployResult.hash);

      // Step 3: Create agent via backend (consumes credit, creates wallet, mints INFT)
      // The AgentFactory listener polls every 15s — retry until credit is available.
      const ownerIdentity = getOrCreateExecutorIdentity(address);
      const deployBody = {
        ownerPublicKey: ownerIdentity.publicKey,
        name: form.name,
        instructions: form.instructions,
        provider: form.provider,
        model: form.model,
        apiKey: form.apiKey,
        capabilities: [],
        tools,
        toolSecrets,
        skillSlugs,
      };
      let result: { id: string } | null = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          result = await authedPost<{ id: string }>('/api/v1/agents/deploy', deployBody);
          break;
        } catch (err: any) {
          if (err.code === 'NO_DEPLOY_CREDIT' && attempt < 5) {
            // Credit not indexed yet — wait for AgentFactory listener
            await new Promise(r => setTimeout(r, 3000));
            continue;
          }
          throw err;
        }
      }
      if (!result) throw new Error('Deploy credit not found after payment. Try again in a moment.');
      setDeployTxHash(result.id);
      setStatus('done');
    } catch (err) {
      setError((err as Error).message);
      setStatus('error');
    } finally {
      submittingRef.current = false;
    }
  }

  if (status === 'done') {
    return (
      <div>
        <Breadcrumb items={['marketplace', 'agents', 'create', 'no-code']} />
        <div className="border border-line p-10 text-center space-y-5 mt-8">
          <div className="flex items-center justify-center gap-2 text-ok">
            <Icon name="check" size={18} />
            <span className="text-sm font-semibold">Agent deployment initiated</span>
          </div>
          <div className="space-y-1.5">
            <div className="text-xs text-ink-3">
              Deploy tx <span className="font-mono text-ink-2">{deployTxHash.slice(0, 10)}...{deployTxHash.slice(-6)}</span>
            </div>
            <div className="text-xs text-ink-3">Backend is creating your agent from the on-chain event...</div>
          </div>

          {privateSkillSlugs.length > 0 && (
            <div className="mx-auto max-w-md text-left space-y-1">
              <div className="text-xs font-medium text-ink-2">Private skills still to attach</div>
              {privateSkillSlugs.map((slug) => (
                <div key={slug} className="flex items-start gap-2 text-xs text-ink-3">
                  <Icon name="clock" size={12} className="mt-0.5 shrink-0" />
                  <span className="min-w-0 break-words">
                    <span className="font-mono">{slug}</span> — add this from the agent's
                    Skills panel once it appears. Private skills can't be installed
                    during an on-chain deploy.
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="mx-auto max-w-md border border-line px-4 py-3 text-left text-[13px] text-ink-2 leading-relaxed space-y-1.5">
            <div className="flex items-center gap-2 font-semibold text-ink">
              <Icon name="info" size={15} />
              <span>Decentralized deployment</span>
            </div>
            <p>
              Your agent is deployed by a smart contract on Base. The backend listens
              for the on-chain event to create your agent. No single point of failure —
              the backend cannot control your agent.
            </p>
          </div>

          <div className="flex justify-center gap-3 flex-wrap pt-1">
            <Button variant="primary" label="My agents" onClick={() => navigate('/agents/mine')} />
            <Button
              variant="ghost"
              label="Deploy another"
              onClick={() => { setStatus('idle'); setDeployTxHash(''); setPrivateSkillSlugs([]); }}
            />
          </div>
          </div>
        </div>
    );
  }

  return (
    <div>
      <Breadcrumb items={['marketplace', 'agents', 'create', 'no-code']} />
      <PageHeader title="Create agent" description="Configure your agent — it will autonomously pick up and complete tasks." />

      <form onSubmit={handleSubmit} className="border border-line">
        {/* 01 — Identity */}
        <div className="p-6 border-b border-line">
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
              <div className="w-full px-3 py-2.5 bg-surface-2 border border-line text-ink-3 text-sm font-mono truncate">
                {address ?? 'Connect wallet'}
              </div>
            </FormField>
          </div>
          <FormField label="Instructions" required className="mt-5">
            <div className="border border-line divide-y divide-line">
              <div className="flex text-xs items-stretch">
                <div className="relative ml-auto">
                  <button type="button" data-tmpl-btn onClick={() => setShowTemplateMenu(!showTemplateMenu)}
                    className="px-3 py-1.5 text-ink-4 hover:text-ink transition-colors text-sm leading-none block">
                    ☰
                  </button>
                  {showTemplateMenu && (
                    <div className="absolute right-0 top-full z-10 w-48 border border-line bg-surface-2 shadow-lg">
                      <div className="px-3 py-1.5 text-[11px] text-ink-4 border-b border-line">Templates</div>
                      {Object.entries(INSTRUCTION_TEMPLATES).map(([key, val]) => (
                        <button key={key} type="button" data-tmpl-btn onClick={() => { set('instructions', val); setShowTemplateMenu(false); }}
                          className="block w-full text-left px-3 py-1.5 text-xs text-ink-2 hover:bg-surface-1 transition-colors">
                          {key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase())}
                        </button>
                      ))}
                      <div className="border-t border-line">
                        <button type="button" data-tmpl-btn onClick={() => { set('instructions', ''); setShowTemplateMenu(false); }}
                          className="block w-full text-left px-3 py-1.5 text-xs text-err hover:bg-surface-1 transition-colors">
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
                className="w-full px-3 py-2.5 bg-surface-2 text-ink text-sm focus:border-cream resize-y leading-relaxed font-mono border-0 outline-none"
              />
            </div>
          </FormField>
        </div>

        {/* 02 — Model */}
        <div className="p-6 border-b border-line">
          <SectionRule num="02" title="Model" />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
            <FormField label="Provider">
              <FormSelect value={form.provider} onChange={e => set('provider', e.target.value)}>
                {Object.keys(providers).map(p => <option key={p} value={p}>{p}</option>)}
              </FormSelect>
            </FormField>
            <FormField label="Model">
              <FormSelect value={form.model} onChange={e => set('model', e.target.value)} className="font-mono">
                {(providers[form.provider] ?? []).map(m => {
                  const p = pricing[form.provider]?.find(x => x.id === m);
                  const cost = p ? (p.inputCostPer1M + p.outputCostPer1M) / 2 : null;
                  return (
                    <option key={m} value={m}>
                      {m}{cost !== null ? (cost === 0 ? ' (free)' : ` (~$${cost.toFixed(2)}/1M)`) : ''}
                    </option>
                  );
                })}
              </FormSelect>
            </FormField>
            <FormField label="API key" required={form.provider !== '0g-compute'} hint={form.provider === '0g-compute' ? 'No API key needed — billed to agent wallet via 0G Compute Router' : undefined}>
              <FormInput
                required={form.provider !== '0g-compute'}
                type="password"
                className={`font-mono ${form.provider === '0g-compute' ? 'opacity-40' : ''}`}
                value={form.apiKey}
                onChange={e => set('apiKey', e.target.value)}
                placeholder={form.provider === '0g-compute' ? 'Auto — uses agent wallet' : 'sk-...'}
                disabled={form.provider === '0g-compute'}
              />
            </FormField>
          </div>

          {/* Model pricing display */}
          {currentModelPricing && (currentModelPricing.inputCostPer1M > 0 || currentModelPricing.outputCostPer1M > 0) && (
            <div className="mt-3 flex items-center gap-4 text-[12px] text-ink-3">
              <span>
                Input: <span className="font-mono text-ink">${currentModelPricing.inputCostPer1M.toFixed(2)}</span> / 1M tokens
              </span>
              <span>
                Output: <span className="font-mono text-ink">${currentModelPricing.outputCostPer1M.toFixed(2)}</span> / 1M tokens
              </span>
              <span className="text-ink-4">
                ~${((currentModelPricing.inputCostPer1M + currentModelPricing.outputCostPer1M) / 2).toFixed(2)} avg / 1M
              </span>
            </div>
          )}
          {currentModelPricing && currentModelPricing.inputCostPer1M === 0 && currentModelPricing.outputCostPer1M === 0 && (
            <div className="mt-3 text-[12px] text-green-400">
              Free — billed via {form.provider === '0g-compute' ? 'agent wallet' : 'provider free tier'}
            </div>
          )}

          {form.provider === '0g-compute' && (
            <div className="mt-4 border border-cream/20 bg-cream/[0.03] px-4 py-3.5 text-[13px] leading-relaxed space-y-2">
              <div className="flex items-center gap-2 font-semibold text-cream">
                <Icon name="bolt" size={14} />
                <span>0G Compute — billed to agent wallet</span>
              </div>
              <div className="text-ink-2 space-y-1">
                {ogPricing[form.model] ? (
                  <p>
                    <span className="font-mono text-ink">{form.model}</span> pricing:
                    {' '}{(+ogPricing[form.model]!.promptUsd * 1000).toFixed(3)}¢ / 1K prompt tokens,
                    {' '}{(+ogPricing[form.model]!.completionUsd * 1000).toFixed(3)}¢ / 1K completion tokens.
                  </p>
                ) : ogPricing[form.model] === undefined ? (
                  <p className="text-ink-3">Loading pricing…</p>
                ) : null}
                <p>
                  Inference is billed to the agent's own wallet, which pays the
                  0G Compute ledger directly.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* 03 — Skills */}
        <div className="p-6 border-b border-line">
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
        <div className="p-6 border-b border-line">
          <SectionRule num="04" title="Tools & MCP servers" side="Optional" />
          <ToolManager tools={tools} onChange={setTools} secrets={toolSecrets} onSecretsChange={setToolSecrets} />
        </div>

        {/* Deploy */}
        <div className="p-6">
          {!address ? (
            <p className="text-sm text-ink-3">Connect a wallet to deploy an agent.</p>
          ) : needsChainSwitch ? (
            <p className="text-sm text-ink-3">Switch to Base network to deploy an agent.</p>
          ) : (
            <>
              <div className="mb-4 border border-line bg-surface-2 px-4 py-3.5 space-y-2">
                <div className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <Icon name="bolt" size={15} className="text-cream" />
                  <span>Deployment uses 2 signatures</span>
                </div>
                <ol className="text-[13px] text-ink-2 leading-relaxed space-y-1 list-decimal list-inside">
                  <li>Approve USDC — allows AgentFactory to charge the deploy fee.</li>
                  <li>Deploy agent — pays {DEPLOY_FEE_HUMAN} USDC, emits on-chain event.</li>
                </ol>
                <div className="text-[13px] text-ink-3 pt-0.5">
                  Your USDC balance:{' '}
                  <span className="font-mono text-ink-2">
                    {usdcBalanceHuman !== null ? `${usdcBalanceHuman.toFixed(2)} USDC` : '…'}
                  </span>
                </div>
              </div>

              {!hasEnoughUsdc && usdcBalanceHuman !== null && (
                <div className="mb-4 border border-err/40 bg-err/5 px-4 py-3.5 text-[13px] text-ink-2 leading-relaxed space-y-1.5">
                  <div className="flex items-center gap-2 font-semibold text-err">
                    <Icon name="bolt" size={15} />
                    <span>Not enough USDC to deploy</span>
                  </div>
                  <p>
                    You need at least <span className="font-mono">{DEPLOY_FEE_HUMAN} USDC</span> for the deploy fee.
                  </p>
                </div>
              )}

              <div className="flex items-center gap-3 flex-wrap">
                <Button
                  type="submit"
                  variant="primary"
                  disabled={status === 'confirming' || status === 'approving' || status === 'deploying' || !hasEnoughUsdc}
                  label={
                    status === 'confirming'
                      ? 'Confirm deploy…'
                      : status === 'approving'
                      ? 'Approving USDC…'
                      : status === 'deploying'
                      ? 'Deploying agent…'
                      : `Deploy agent (${DEPLOY_FEE_HUMAN} USDC) →`
                  }
                />
              </div>
            </>
          )}
          {status === 'error' && <p className="mt-3 text-sm text-err break-words">{error}</p>}
        </div>
      </form>
      <ConfirmDialog
        open={status === 'confirming'}
        title="Deploy agent"
        description={
          <div className="space-y-2">
            <p className="text-sm text-ink-2">Review before deploying:</p>
            <div className="rounded-lg bg-surface-2 p-3 space-y-1.5 font-mono text-xs">
              <div className="flex justify-between">
                <span className="text-ink-3">Deploy fee</span>
                <span>1 USDC</span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink-3">Gas (paid in USDC)</span>
                <span>~0.001 USDC</span>
              </div>
              <div className="border-t border-line pt-1.5 flex justify-between font-semibold">
                <span>Total</span>
                <span>~1.001 USDC</span>
              </div>
            </div>
            <p className="text-xs text-ink-3">Gas is sponsored by Privy and paid in USDC — no ETH needed.</p>
          </div>
        }
        confirmLabel="Confirm deploy"
        onConfirm={() => confirmResolveRef.current?.(true)}
        onCancel={() => confirmResolveRef.current?.(false)}
      />
    </div>
  );
}
