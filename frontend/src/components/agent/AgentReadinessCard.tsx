import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../context/AuthContext';
import { authedGet } from '../../lib/api';
import { OG_COMPUTE_ACCOUNT_0G, readinessView, type AgentReadiness } from '../../lib/agentReadiness';
import { CopyButton, Icon } from '../bb';

/**
 * A warning box. Tailwind can't put an opacity modifier on the semantic colors
 * (warn is `var(--bb-warn)`), so `border-warn/60 bg-warn/5` generate nothing;
 * color-mix gives the intended tint.
 */
export const WARN_BOX =
  'border border-[color:color-mix(in_srgb,var(--bb-warn)_55%,transparent)] bg-[color:color-mix(in_srgb,var(--bb-warn)_6%,transparent)]';

/**
 * Owner-only: whether this agent is taking tasks, from its worker's last
 * heartbeat. A running agent takes no task until its model answers a check;
 * a 0g-compute agent first needs 0G in its wallet to open its 0G Compute
 * account, and this says how much and where to send it.
 */
export function AgentReadinessCard({ agentId, running, className = '' }: { agentId: string; running: boolean; className?: string }) {
  const { isAuthenticated } = useAuth();
  const { data } = useQuery({
    queryKey: ['agent-readiness', agentId],
    queryFn: () => authedGet<{ readiness: AgentReadiness | null }>(`/api/v1/agents/${agentId}/readiness`),
    enabled: isAuthenticated && running,
    refetchInterval: 20_000,
  });
  if (!running) return null;
  const view = readinessView(data?.readiness);

  if (view.kind === 'ready' || view.kind === 'checking') {
    const ready = view.kind === 'ready';
    return (
      <div className={`border border-line px-5 py-3 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm ${className}`}>
        <span className={`h-1.5 w-1.5 shrink-0 ${ready ? 'bg-ok' : 'bg-ink-3 animate-pulse'}`} aria-hidden />
        <span className="text-ink">{ready ? 'Taking tasks' : 'Checking its model'}</span>
        <span className="text-ink-3">
          {ready ? 'Its model answered the last check.' : 'It takes no task until the check passes.'}
        </span>
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
              <div className="flex items-center justify-between gap-2 border border-line bg-surface-2 px-3 py-2">
                <span className="font-mono text-xs text-ink break-all">{view.address}</span>
                <CopyButton text={view.address} />
              </div>
              <p className="text-xs text-ink-3">
                Holds {view.holds} 0G of the {view.need} 0G it needs. It checks again every 5 minutes, so no restart is needed.
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
