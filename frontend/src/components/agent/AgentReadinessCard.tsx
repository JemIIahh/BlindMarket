import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../context/AuthContext';
import { authedGet } from '../../lib/api';
import { OG_COMPUTE_ACCOUNT_0G, readinessView, type AgentReadiness, type GasState } from '../../lib/agentReadiness';
import { CopyButton, Icon } from '../bb';

/**
 * A warning box. Tailwind can't put an opacity modifier on the semantic colors
 * (warn is `var(--bb-warn)`), so `border-warn/60 bg-warn/5` generate nothing;
 * color-mix gives the intended tint.
 */
export const WARN_BOX =
  'rounded-2xl border border-[color:color-mix(in_srgb,var(--bb-warn)_55%,transparent)] bg-[color:color-mix(in_srgb,var(--bb-warn)_6%,transparent)]';

/**
 * Owner-only: whether this agent is taking tasks, from its worker's last
 * heartbeat and its gas. A running agent takes no task until its model
 * answers a check; a 0g-compute agent first needs 0G in its wallet to open
 * its 0G Compute account, and this says how much and where to send it. With
 * its model fine, it still takes no task whose gas its wallet can't pay,
 * unless BlindMarket pays it.
 */
export function AgentReadinessCard({ agentId, running, gas, className = '' }: { agentId: string; running: boolean; gas?: GasState; className?: string }) {
  const { isAuthenticated } = useAuth();
  const { data } = useQuery({
    queryKey: ['agent-readiness', agentId],
    queryFn: () => authedGet<{ readiness: AgentReadiness | null }>(`/api/v1/agents/${agentId}/readiness`),
    enabled: isAuthenticated && running,
    refetchInterval: 20_000,
  });
  if (!running) return null;
  const view = readinessView(data?.readiness, gas);

  if (view.kind === 'ready' || view.kind === 'checking' || view.kind === 'sponsored_only') {
    const ready = view.kind !== 'checking';
    const title = view.kind === 'sponsored_only' ? 'Taking tasks whose gas BlindMarket pays' : ready ? 'Taking tasks' : 'Checking its model';
    const detail =
      view.kind === 'sponsored_only'
        ? `Its wallet holds less than ${view.minLabel ?? 'one transaction\'s gas'}${view.minLabel ? ` ${view.symbol}` : ''}, so it takes no other task. Top it up to take the rest.`
        : view.kind === 'ready'
          ? view.sponsored
            ? 'Its model answered the last check. BlindMarket pays the gas of its first submit on qualifying tasks.'
            : 'Its model answered the last check.'
          : 'It takes no task until the check passes.';
    return (
      <div className={`card-dark px-5 py-3.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm ${className}`}>
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${ready ? 'bg-ok' : 'bg-ink-3 animate-pulse'}`} aria-hidden />
        <span className="text-ink">{title}</span>
        <span className="text-ink-3">{detail}</span>
      </div>
    );
  }

  return (
    <div className={`${WARN_BOX} px-5 py-4 ${className}`}>
      <div className="flex items-start gap-3">
        <Icon name="alert" size={16} className="text-warn shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1 space-y-2.5">
          {view.kind === 'fund' ? (
            <>
              <div className="text-sm font-semibold text-ink">Fund this agent to start taking tasks</div>
              <p className="text-sm text-ink-2 leading-relaxed">
                Send at least <span className="font-semibold text-ink">{view.send} 0G</span> on the 0G chain to its wallet.{' '}
                {OG_COMPUTE_ACCOUNT_0G} 0G opens its 0G Compute account, which pays for its model calls; the rest covers gas.
              </p>
              <div className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2">
                <span className="font-mono text-xs text-ink break-all">{view.address}</span>
                <CopyButton text={view.address} />
              </div>
              <p className="text-xs text-ink-3">
                Holds {view.holds} 0G of the {view.need} 0G it needs. It checks again every 5 minutes, so no restart is needed.
              </p>
            </>
          ) : view.kind === 'gas' ? (
            <>
              <div className="text-sm font-semibold text-ink">Not taking tasks</div>
              <p className="text-sm text-ink-2 leading-relaxed">
                {view.minLabel !== null ? (
                  <>
                    Its wallet holds less than <span className="font-mono">{view.minLabel} {view.symbol}</span>, what one
                    transaction can cost at current gas prices.
                  </>
                ) : (
                  <>Its wallet is empty, so it can't pay gas.</>
                )}{' '}
                {view.sponsorshipPaused ? 'Gas sponsorship is paused.' : 'Top it up below to resume.'}
              </p>
            </>
          ) : (
            <>
              <div className="text-sm font-semibold text-ink">Not taking tasks</div>
              <p className="text-sm text-ink-2 leading-relaxed break-words">{view.reason}</p>
              <p className="text-xs text-ink-3">It checks again every 5 minutes.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
