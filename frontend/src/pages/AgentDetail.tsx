import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useWalletClient } from 'wagmi';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BrowserProvider, Contract, parseUnits, formatUnits } from 'ethers';
import {
  Breadcrumb,
  SectionRule,
  Button,
  LoadingState,
  EmptyState,
  ErrorState,
  ConfirmDialog,
} from '../components/bb';
import { get, authedGet, authedPost } from '../lib/api';
import { useChainAddress } from '../hooks/useChainWallet';
import { MARKETPLACE_TOKEN_ADDRESS, getPaymentSymbol, getPaymentDecimals } from '../config/constants';
import {
  getAgentReviews,
  getAgentBadges,
  listServices,
} from '../services/marketplace';
import type { AgentReview, AgentReviewStats, AgentBadge, AgentService } from '../services/marketplace';

import { AgentHeader } from '../components/agent/AgentHeader';
import { AgentStats } from '../components/agent/AgentStats';
import { AgentTasks } from '../components/agent/AgentTasks';
import { GasBar } from '../components/agent/GasBar';
import { IdentityPanel } from '../components/agent/IdentityPanel';
import { OpsConsole } from '../components/agent/OpsConsole';
import { ReviewsSection } from '../components/agent/ReviewsSection';
import { ServicesSection } from '../components/agent/ServicesSection';
import type { AgentDetails, SkillStat } from '../components/agent/types';

// Top-up amount in USDC. Covers ~100 task executions before next top-up.
const TOP_UP_AMOUNT = '1';
const TOP_UP_RAW = parseUnits(TOP_UP_AMOUNT, getPaymentDecimals());

// Below this the agent can't reliably pay for operations. UI surfaces a
// "Fund wallet" call to action when balance is under this.
const LOW_BALANCE_THRESHOLD = parseUnits('1', getPaymentDecimals());

const USDC_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

const ACTION_LABELS: Record<'start' | 'pause' | 'stop' | 'restart', string> = {
  start: 'Start',
  pause: 'Pause',
  stop: 'Stop',
  restart: 'Restart',
};

export default function AgentDetail() {
  const { id } = useParams<{ id: string }>();
  const address = useChainAddress();
  const { data: walletClient } = useWalletClient();
  const qc = useQueryClient();

  const [agent, setAgent] = useState<AgentDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [searchParams] = useSearchParams();

  // Canonical id for API calls. The route param may be a WALLET ADDRESS
  // (Browse links by address; the GET endpoint resolves both) but the
  // action/PATCH/console endpoints resolve by agent id only — so once the
  // record loads, talk to the API by its real id, not the raw param.
  const apiId = agent?.id ?? id ?? '';

  // Reviews state
  const [reviews, setReviews] = useState<AgentReview[]>([]);
  const [reviewStats, setReviewStats] = useState<AgentReviewStats | null>(null);

  // Badges state
  const [badges, setBadges] = useState<AgentBadge[]>([]);
  // Per-skill track record (settled completions/failures per capability tag) —
  // the proof layer buyers hire on.
  const [skillStats, setSkillStats] = useState<SkillStat[]>([]);

  // Gas-management UI state — separate from the agent's start/pause/stop
  // actions so the buttons can show their own progress without interfering.
  const [topUpStatus, setTopUpStatus] = useState<'idle' | 'sending' | 'error'>('idle');
  const [topUpError, setTopUpError] = useState('');
  const [withdrawStatus, setWithdrawStatus] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [withdrawConfirmOpen, setWithdrawConfirmOpen] = useState(false);
  const [withdrawInfo, setWithdrawInfo] = useState<Array<{ chain: string; asset: string; amount: string; txHash: string }> | null>(null);
  const [withdrawError, setWithdrawError] = useState('');

  // Owner-link recovery state — for the "deployed with one wallet, signed in
  // as another" lock-out. Drives the inline recovery button in the action-error
  // banner (signature-gated POST /agents/:id/link-owner).
  const [linkStatus, setLinkStatus] = useState<'idle' | 'signing' | 'linking' | 'error'>('idle');
  const [linkError, setLinkError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  // USDC balance on Base
  const [usdcBalance, setUsdcBalance] = useState<bigint | null>(null);

  const balanceEther = usdcBalance !== null ? Number(formatUnits(usdcBalance, getPaymentDecimals())) : 0;
  const balanceSymbol = getPaymentSymbol();
  const isLowGas = usdcBalance !== null && usdcBalance < LOW_BALANCE_THRESHOLD;

  // ERC-4337 AA: gas is paid in USDC via paymaster from the smart account.
  // Fallback to the EOA wallet for pre-AA agents.
  const fundingAddress = agent?.smartAccountAddress || agent?.walletAddress;
  const agentWallet = agent?.walletAddress;

  const refetchBalance = useCallback(async () => {
    if (!fundingAddress || !walletClient) return;
    try {
      const provider = new BrowserProvider(walletClient.transport);
      const usdc = new Contract(MARKETPLACE_TOKEN_ADDRESS, USDC_ABI, provider);
      const bal = await usdc.balanceOf(fundingAddress);
      setUsdcBalance(bal as bigint);
    } catch { /* non-blocking */ }
  }, [fundingAddress, walletClient]);

  const loadAgent = useCallback(() => {
    if (!id) return;
    setLoading(true);
    setFetchError(false);
    get<AgentDetails>(`/api/v1/agents/${id}`)
      .then(data => setAgent(data))
      // A rejected fetch can't tell 404 from a transient 500/network drop, so
      // surface a retryable error rather than masquerading as "not found".
      .catch(() => setFetchError(true))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => { loadAgent(); }, [loadAgent]);

  useEffect(() => {
    if (!agentWallet) return;
    let cancelled = false;
    getAgentBadges(agentWallet).then(b => { if (!cancelled) setBadges(b); }).catch(() => {});
    authedGet<{ stats: SkillStat[] }>(
      `/api/v1/marketplace/skill-stats/${agentWallet}`,
    ).then(r => { if (!cancelled) setSkillStats(r.stats ?? []); }).catch(() => {});
    return () => { cancelled = true; };
  }, [agentWallet]);

  // Fetch USDC balance when agent loads
  useEffect(() => {
    if (!fundingAddress || !walletClient) return;
    let cancelled = false;
    (async () => {
      try {
        const provider = new BrowserProvider(walletClient.transport);
        const usdc = new Contract(MARKETPLACE_TOKEN_ADDRESS, USDC_ABI, provider);
        const bal = await usdc.balanceOf(fundingAddress);
        if (!cancelled) setUsdcBalance(bal as bigint);
      } catch { /* non-blocking */ }
    })();
    return () => { cancelled = true; };
  }, [fundingAddress, walletClient]);

  // Public service list — lifted out of the services section because the
  // header's from-price and the "services sold" stat read the same data.
  const [services, setServices] = useState<AgentService[] | null>(null);
  const [servicesLoading, setServicesLoading] = useState(true);
  const [servicesError, setServicesError] = useState(false);

  const reloadServices = useCallback(async () => {
    if (!agentWallet) { setServices([]); setServicesLoading(false); return; }
    setServicesLoading(true);
    setServicesError(false);
    try {
      const res = await listServices(agentWallet);
      setServices(res.services);
    } catch {
      setServicesError(true);
    } finally {
      setServicesLoading(false);
    }
  }, [agentWallet]);

  useEffect(() => { reloadServices(); }, [reloadServices]);

  // Cheapest active listing, mirroring the marketplace card's from-price.
  // Per-value try/catch: one malformed price_raw must not blank the label.
  const fromPrice = useMemo(() => {
    let min: bigint | null = null;
    for (const s of services ?? []) {
      if (s.active === false) continue;
      try {
        const v = BigInt(s.price_raw);
        if (min === null || v < min) min = v;
      } catch { /* skip malformed price */ }
    }
    if (min === null) return null;
    try { return `from ${formatUnits(min, 18)} ${balanceSymbol} / call`; } catch { return null; }
  }, [services, balanceSymbol]);

  const servicesSold = useMemo(() => {
    const total = (services ?? []).reduce((n, s) => n + (s.sold_count ?? 0), 0);
    return total > 0 ? total : null;
  }, [services]);

  const reloadReviews = useCallback(async () => {
    if (!agentWallet) return;
    try {
      const result = await getAgentReviews(agentWallet, 20);
      setReviews(result.reviews);
      setReviewStats(result.stats);
    } catch { /* reputation is additive — a failed refetch just leaves the list */ }
  }, [agentWallet]);

  useEffect(() => { reloadReviews(); }, [reloadReviews]);

  // Deep-link compatibility: ?tab=services|reviews|tasks used to select a tab.
  // Those panels are flat sections now, so scroll to the section once the
  // agent (and therefore the section) has rendered.
  const deepLinkScrolled = useRef(false);
  useEffect(() => {
    if (deepLinkScrolled.current || !agent) return;
    const raw = searchParams.get('tab');
    if (raw !== 'services' && raw !== 'reviews' && raw !== 'tasks') return;
    deepLinkScrolled.current = true;
    document.getElementById(raw)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [agent, searchParams]);

  const action = useMutation({
    mutationFn: (act: 'start' | 'pause' | 'stop' | 'restart') =>
      authedPost<AgentDetails>(`/api/v1/agents/${apiId}/${act}`, {}),
    onSuccess: (data) => { setAgent(data); qc.invalidateQueries({ queryKey: ['my-agents'] }); },
  });

  // Signature-gated owner-link recovery. When start/stop 403s because the agent
  // was deployed with a different wallet than the current Privy sign-in, the
  // user proves control of the owner wallet (their active wagmi wallet) by
  // signing a server nonce. That adds their Privy identity to authorizedOwners,
  // after which authorizeOwner stops rejecting them. We then retry the action.
  // Reusable owner-link: prove control of the owner wallet (sign a server nonce)
  // so the backend adds this Privy identity to authorizedOwners. Throws on
  // failure. Shared by the Start/Stop recovery banner AND the Services form 403.
  async function linkOwner(): Promise<void> {
    const challenge = await authedPost<{ nonce: string; message: string; ownerAddress: string }>(
      `/api/v1/agents/${apiId}/link-owner/challenge`,
      {},
    );
    if (!walletClient) throw new Error('Wallet not connected');
    const signature = await walletClient.signMessage({ message: challenge.message });
    await authedPost(`/api/v1/agents/${apiId}/link-owner`, { nonce: challenge.nonce, signature });
  }

  async function handleLinkOwner() {
    setLinkStatus('signing');
    setLinkError('');
    try {
      await linkOwner();
      setLinkStatus('idle');
      // Refresh the record (now carries authorizedOwners) and retry whatever
      // action triggered the lock-out (defaults to start).
      try { setAgent(await get<AgentDetails>(`/api/v1/agents/${apiId}`)); } catch { /* non-blocking */ }
      action.mutate(action.variables ?? 'start');
    } catch (err) {
      setLinkError((err as Error).message || 'Could not link this wallet');
      setLinkStatus('error');
    }
  }

  // Owner-signed transfer from owner wallet → agent wallet. No backend
  // involvement; same primitive as the deploy-funding step. We refresh the
  // balance after the tx confirms so the UI tile updates immediately
  // instead of waiting on a poll cycle.
  const [topUpConfirm, setTopUpConfirm] = useState(false);
  function requestTopUp() {
    if (!address || !fundingAddress) return;
    setTopUpConfirm(true);
  }
  async function confirmTopUp() {
    if (!address || !fundingAddress) return;
    setTopUpConfirm(false);
    setTopUpStatus('sending');
    try {
      const provider = new BrowserProvider(walletClient!.transport);
      const signer = await provider.getSigner();
      const usdc = new Contract(MARKETPLACE_TOKEN_ADDRESS, USDC_ABI, signer);
      const tx = await usdc.transfer.populateTransaction(fundingAddress, TOP_UP_RAW);
      const { signAndSendTx } = await import('../lib/txSigner');
      const sent = await signAndSendTx(signer, tx as any);
      if (sent.receipt) {
        await refetchBalance();
      }
      setTopUpStatus('idle');
    } catch (err) {
      setTopUpError((err as Error).message || 'Top-up failed');
      setTopUpStatus('error');
    }
  }

  // Backend signs the withdrawal tx using the agent's stored rawPrivateKey and
  // sends funds back to the owner. The agent's wallet is the same EOA on both
  // 0G and Base, so the single /withdraw endpoint checks both chains and
  // sweeps whichever have a sweepable balance — omit tokenAddress for a
  // native sweep, or pass a specific ERC20 address to withdraw that token.
  // The response lists one entry per chain actually swept (0, 1, or 2).
  //
  // Uses authedPost so the JWT (Privy identity) flows to the backend, where
  // requireAuth + authorizeOwner verify the caller is the agent's owner.
  // Refuses while the agent is running to avoid racing with in-flight txs.
  async function handleWithdraw() {
    if (!address || !id) return;
    setWithdrawConfirmOpen(false);
    setWithdrawStatus('sending');
    setWithdrawError('');
    try {
      const data = await authedPost<{
        swept: Array<{ chain: string; asset: string; txHash: string; amountSent?: string; amountFormatted?: string; amountRaw?: string }>;
        skipped?: Array<{ chain: string; reason: string }>;
      }>(`/api/v1/agents/${apiId}/withdraw`, {});
      if (!data.swept.length) {
        throw new Error('Nothing to withdraw on either chain.');
      }
      setWithdrawInfo(
        data.swept.map((s) => ({
          chain: s.chain,
          asset: s.asset,
          amount: s.amountFormatted ?? s.amountSent ?? s.amountRaw ?? '0',
          txHash: s.txHash,
        })),
      );
      setWithdrawStatus('done');
      await refetchBalance();
      try {
        const fresh = await get<AgentDetails>(`/api/v1/agents/${apiId}`);
        setAgent(fresh);
      } catch { /* non-blocking */ }
    } catch (err) {
      setWithdrawError((err as Error).message || 'Withdraw failed');
      setWithdrawStatus('error');
    }
  }

  if (loading) return <LoadingState label="Loading agent…" />;
  if (!agent) {
    return (
      <div className="border border-line">
        {fetchError ? (
          <ErrorState title="Couldn't load this agent" onRetry={() => loadAgent()} />
        ) : (
          <EmptyState icon="search" title="Agent not found" description="This agent does not exist or is no longer available." />
        )}
      </div>
    );
  }

  const isOwner = address?.toLowerCase() === agent.ownerAddress?.toLowerCase();

  // okx-style buy signals for the header strip. `distribution` is defensive-
  // defaulted: a stats payload without it must not crash the whole page.
  const reviewDist: Record<number, number> = reviewStats?.distribution ?? {};
  const positivePct =
    reviewStats && reviewStats.totalReviews > 0
      ? Math.round((((reviewDist[4] ?? 0) + (reviewDist[5] ?? 0)) / reviewStats.totalReviews) * 100)
      : null;

  return (
    <>
    <div>
      <Breadcrumb items={['marketplace', 'agents', isOwner ? 'mine' : 'browse', agent.name]} />

      <AgentHeader
        agent={agent}
        displayStatus={action.isPending ? action.variables : agent.status}
        badgeCount={badges.length}
        fromPrice={fromPrice}
        isOwner={isOwner}
        actionPending={action.isPending}
        onAction={(act) => action.mutate(act)}
      />
      {action.isError && (
        <div className="mb-4 px-4 py-2.5 border border-err/40 bg-err/10 text-xs text-err">
          <div>
            {ACTION_LABELS[action.variables]} failed:{' '}
            <span className="font-mono">{(action.error as Error).message}</span>
          </div>
          {(action.error as { code?: string }).code === 'FORBIDDEN' && walletClient && (
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={linkStatus === 'signing' || linkStatus === 'linking'}
                onClick={handleLinkOwner}
                label={
                  linkStatus === 'signing' ? 'Sign in your wallet…'
                    : linkStatus === 'linking' ? 'Linking…'
                      : 'Link this wallet to the agent'
                }
              />
              <span className="text-ink-3">
                One signature with your owner wallet authorizes this sign-in. No gas.
              </span>
            </div>
          )}
          {linkError && <div className="mt-1.5 font-mono">{linkError}</div>}
        </div>
      )}

      <AgentStats
        className="mb-6"
        isOwner={isOwner}
        reviewStats={reviewStats}
        positivePct={positivePct}
        tasksCompleted={agent.tasksCompleted ?? 0}
        reputationScore={agent.decayedReputation?.decayedScore ?? agent.reputation?.score ?? 0}
        disputes={agent.reputation?.disputes ?? 0}
        totalEarned={agent.totalEarned ?? '0'}
        symbol={balanceSymbol}
        balanceEther={balanceEther}
        isLowGas={isLowGas}
        servicesSold={servicesSold}
        walletAddress={agent.walletAddress}
        onFund={() => document.getElementById('operations')?.scrollIntoView({ behavior: 'smooth' })}
      />

      {/* Identity strip — single horizontal row below stats */}
      <IdentityPanel agent={agent} badges={badges} skillStats={skillStats} />

      {/* Storefront — services and reputation as flat sections. */}
      <div className="mt-10 space-y-10">
        <ServicesSection
          agentId={apiId}
          isOwner={isOwner}
          symbol={balanceSymbol}
          agentStatus={agent.status}
          services={services}
          loading={servicesLoading}
          loadError={servicesError}
          onReload={reloadServices}
          onLinkOwner={linkOwner}
        />

        <ReviewsSection
          reviews={reviews}
          stats={reviewStats}
        />

        {/* Visitors get the work history inline; the owner keeps it as a
            console tab, next to the logs it correlates with. Signed-out
            viewers get nothing rather than an error box: /a2a/executions is
            requireAuth, and this section now loads eagerly instead of on a
            tab click. */}
        {!isOwner && !!address && (
          <section id="tasks" className="scroll-mt-6">
            <SectionRule num="03" title="Recent tasks" />
            <AgentTasks agentWallet={agent.walletAddress} />
          </section>
        )}
      </div>

      {/* Operations — owner-only. Gas strip fused to the console below it. */}
      {isOwner && (
        <div id="operations" className="mt-12 scroll-mt-6">
          <SectionRule num="03" title="Operations" />
          {agent.walletAddress && (
            <GasBar
              symbol={balanceSymbol}
              topUpAmount={TOP_UP_AMOUNT}
              lowGasThreshold={1}
              isLowGas={isLowGas}
              balanceEther={balanceEther}
              agentStatus={agent.status}
              ownerLabel={address ? `${address.slice(0, 8)}…` : 'your wallet'}
              topUpStatus={topUpStatus}
              topUpError={topUpError}
              withdrawStatus={withdrawStatus}
              withdrawError={withdrawError}
              withdrawInfo={withdrawInfo}
              confirmOpen={withdrawConfirmOpen}
              refreshing={refreshing}
              onTopUp={requestTopUp}
              onRefresh={async () => { setRefreshing(true); await refetchBalance(); setRefreshing(false); }}
              onWithdrawRequest={() => setWithdrawConfirmOpen(true)}
              onWithdrawConfirm={handleWithdraw}
              onWithdrawCancel={() => setWithdrawConfirmOpen(false)}
            />
          )}
          <OpsConsole
            key={agent.id}
            agentId={apiId}
            agent={agent}
            onAgentUpdated={setAgent}
            className={agent.walletAddress ? 'border-t-0' : ''}
          />
        </div>
      )}
    </div>
    <ConfirmDialog
      open={topUpConfirm}
      title="Fund agent wallet"
      description={`Send ${TOP_UP_AMOUNT} USDC from your wallet to ${fundingAddress?.slice(0, 10)}…${fundingAddress?.slice(-8)} for operations. This will be deducted from your wallet.`}
      confirmLabel="Send USDC"
      onConfirm={confirmTopUp}
      onCancel={() => setTopUpConfirm(false)}
    />
    </>
  );
}
