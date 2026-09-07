import { StatCard } from '../bb';
import { truncateAddress } from '../../lib/utils';
import { OG_CHAIN_CONFIG, getPaymentSymbol } from '../../config/constants';
import type { AgentReviewStats } from '../../services/marketplace';

/**
 * Buy-signal strip. One hairline grid (gap-px over bg-line) instead of the
 * hand-rolled per-cell dividers, so the cells never double up borders.
 * The 4th cell is audience-aware: owners get the wallet balance they operate
 * on, buyers get the on-chain identity they'd verify.
 */
export function AgentStats({
  isOwner,
  reviewStats,
  positivePct,
  tasksCompleted,
  reputationScore,
  disputes,
  totalEarned,
  symbol,
  balanceEther,
  isLowGas,
  servicesSold,
  walletAddress,
  className = '',
}: {
  isOwner: boolean;
  reviewStats: AgentReviewStats | null;
  positivePct: number | null;
  tasksCompleted: number;
  reputationScore: number;
  disputes: number;
  totalEarned: string;
  symbol: string;
  balanceEther: number;
  isLowGas: boolean;
  servicesSold: number | null;
  walletAddress?: string;
  className?: string;
}) {
  const hasReviews = !!reviewStats && reviewStats.totalReviews > 0;
  const earnedValue = `${parseFloat(totalEarned || '0').toLocaleString(undefined, { maximumFractionDigits: 4 })} ${getPaymentSymbol()}`;

  return (
    <div className={`grid grid-cols-1 sm:grid-cols-4 gap-px bg-line border border-line ${className}`}>
      <StatCard
        className="border-0"
        label="Score"
        value={hasReviews ? `★ ${reviewStats!.avgRating.toFixed(2)}` : '—'}
        sub={hasReviews ? `${positivePct}% positive · ${reviewStats!.totalReviews} reviews` : 'No reviews yet'}
        subColor={positivePct != null && positivePct >= 80 ? 'ok' : 'default'}
      />
      <StatCard
        className="border-0"
        label="Tasks completed"
        value={String(tasksCompleted)}
        sub={`Reputation ${reputationScore}${disputes ? ` · ${disputes} disputes` : ''}`}
        subColor={disputes > 0 ? 'warn' : 'default'}
      />
      {isOwner || servicesSold == null ? (
        <StatCard
          className="border-0"
          label="Earned"
          value={earnedValue}
          sub={getPaymentSymbol()}
          subColor="ok"
        />
      ) : (
        <StatCard
          className="border-0"
          label="Services sold"
          value={String(servicesSold)}
          sub={`${earnedValue} earned`}
          subColor="ok"
        />
      )}
      {isOwner ? (
        <StatCard
          className="border-0"
          label="Wallet balance"
          value={balanceEther > 0 ? balanceEther.toFixed(4) : '—'}
          sub={isLowGas ? 'Low gas — top up' : symbol}
          subColor={isLowGas ? 'warn' : 'default'}
        />
      ) : (
        <div className="bg-surface p-5 min-w-0 overflow-hidden flex flex-col justify-center">
          <div className="text-[10px] font-mono font-semibold uppercase tracking-widest text-ink-3 mb-2 truncate">
            On-chain
          </div>
          {walletAddress ? (
            <>
              <div className="font-mono text-sm text-ink truncate">{truncateAddress(walletAddress)}</div>
              <a
                href={`${OG_CHAIN_CONFIG.blockExplorerUrls[0]}/address/${walletAddress}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 font-mono text-[11px] uppercase tracking-widest text-ink-3 hover:text-cream transition-colors"
              >
                view all ↗
              </a>
            </>
          ) : (
            <div className="font-mono text-sm text-ink-3">—</div>
          )}
        </div>
      )}
    </div>
  );
}
