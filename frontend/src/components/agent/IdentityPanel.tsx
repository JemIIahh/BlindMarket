import { Icon, Tag } from '../bb';
import { truncateAddress } from '../../lib/utils';
import { ExplorerAddressLinks } from '../ExplorerLinks';
import type { AgentBadge } from '../../services/marketplace';
import type { AgentDetails, SkillStat } from './types';

export function IdentityPanel({
  agent,
  badges,
  skillStats,
}: {
  agent: AgentDetails;
  badges: AgentBadge[];
  skillStats: SkillStat[];
}) {
  const score =
    agent.decayedReputation?.decayedScore ?? agent.reputation?.score ?? 0;
  const tasks = agent.reputation?.tasksCompleted ?? 0;
  const disputes = agent.reputation?.disputes ?? 0;

  return (
    <div className="border border-line rounded-lg px-4 py-3 overflow-x-auto">
      <div className="flex items-center gap-6 min-w-max text-sm text-ink-2">
        {/* Owner */}
        <div className="flex items-center gap-1.5">
          <Icon name="user" size={14} className="text-ink-3" />
          <span className="text-ink-3 text-[12px]">Owner</span>
          <span className="font-mono text-ink">{truncateAddress(agent.ownerAddress)}</span>
        </div>

        {/* Agent wallet — same EOA on both chains (USDC on Base,
            identity/reputation on 0G), so link both explorers. */}
        {agent.walletAddress && (
          <div className="flex items-center gap-1.5">
            <Icon name="wallet" size={14} className="text-ink-3" />
            <span className="text-ink-3 text-[12px]">Wallet</span>
            <span className="font-mono text-ink" title={agent.walletAddress}>
              {truncateAddress(agent.walletAddress)}
            </span>
            <ExplorerAddressLinks
              address={agent.walletAddress}
              className="font-mono text-[11px] text-ink-3"
            />
          </div>
        )}

        {/* INFT token */}
        {agent.inftTokenId !== undefined && (
          <div className="flex items-center gap-1.5">
            <Icon name="lock" size={14} className="text-ink-3" />
            <span className="text-ink-3 text-[12px]">INFT</span>
            <span className="font-mono text-cream">#{agent.inftTokenId}</span>
          </div>
        )}

        {/* Reputation */}
        <div className="flex items-center gap-1.5">
          <Icon name="chart" size={14} className="text-ink-3" />
          <span className="text-ink-3 text-[12px]">Rep</span>
          <span className="font-mono">{String(score)}</span>
          <span className="text-ink-3 font-mono text-[11px]">
            {tasks} tasks{disputes > 0 ? ` · ${disputes} disputes` : ''}
          </span>
        </div>

        {/* Badges */}
        {badges.length > 0 && (
          <div className="flex items-center gap-1.5">
            {badges.map((b) => (
              <Tag key={b.capability ?? String(b.id)} tone="ok">
                {(b.capability ?? '').replace(/_/g, ' ')}
              </Tag>
            ))}
          </div>
        )}

        {/* Skill stats */}
        {skillStats.length > 0 && (
          <div className="flex items-center gap-1.5 text-[11px] font-mono">
            <span className="text-ink-3">
              {skillStats.reduce((a, s) => a + s.tasks_completed, 0)}✓
            </span>
            {skillStats.reduce((a, s) => a + s.tasks_failed, 0) > 0 && (
              <span className="text-err">
                {skillStats.reduce((a, s) => a + s.tasks_failed, 0)}✗
              </span>
            )}
          </div>
        )}

        {/* Deployed — right-aligned via margin-left auto */}
        <div className="flex items-center gap-1.5 ml-auto">
          <Icon name="clock" size={14} className="text-ink-3" />
          <span className="text-ink-3 text-[12px]">
            {new Date(agent.deployedAt).toLocaleDateString()}
          </span>
        </div>
      </div>
    </div>
  );
}
