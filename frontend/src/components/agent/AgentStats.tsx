import { Icon } from '../bb/Icon';
import { Button } from '../bb/Button';
import { truncateAddress } from '../../lib/utils';
import { getPaymentSymbol } from '../../config/constants';
import { ExplorerAddressLinks } from '../ExplorerLinks';
import type { AgentReviewStats } from '../../services/marketplace';

/**
 * Buy-signal strip — 4-column grid of stat cards.
 *
 * Cards 1-2 (Score, Tasks) are neutral surface cards.
 * Card 3 (Earned) is tinted success/green.
 * Card 4 (Wallet / On-chain) is tinted warning/amber when gas is low,
 * and includes a "Fund" outline button for the owner.
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
  onFund,
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
  onFund?: () => void;
}) {
  const hasReviews = !!reviewStats && reviewStats.totalReviews > 0;
  const earnedValue = `${parseFloat(totalEarned || '0').toLocaleString(undefined, { maximumFractionDigits: 4 })} ${getPaymentSymbol()}`;

  return (
    <div className={`grid grid-cols-2 sm:grid-cols-4 gap-3 ${className}`}>
      {/* ── Score ─────────────────────────────────────────────── */}
      <div className="card-dark p-5 min-w-0 overflow-hidden flex flex-col">
        <div className="flex items-center gap-1.5 text-ink-3 mb-2">
          <Icon name="bolt" size={12} className="text-ink-3" />
          <span className="text-[10px] font-mono font-semibold uppercase tracking-widest truncate">
            Score
          </span>
        </div>
        <div className="text-[28px] sm:text-[32px] font-mono font-bold text-ink leading-none tracking-tightest truncate">
          {hasReviews ? reviewStats!.avgRating.toFixed(2) : '—'}
        </div>
        <div className="mt-1.5 text-[11px] font-mono text-ink-3 truncate">
          {hasReviews
            ? `${positivePct}% positive · ${reviewStats!.totalReviews} reviews`
            : 'No reviews yet'}
        </div>
      </div>

      {/* ── Tasks Completed ───────────────────────────────────── */}
      <div className="card-dark p-5 min-w-0 overflow-hidden flex flex-col">
        <div className="flex items-center gap-1.5 text-ink-3 mb-2">
          <Icon name="check" size={12} className="text-ink-3" />
          <span className="text-[10px] font-mono font-semibold uppercase tracking-widest truncate">
            Tasks
          </span>
        </div>
        <div className="text-[28px] sm:text-[32px] font-mono font-bold text-ink leading-none tracking-tightest truncate">
          {String(tasksCompleted)}
        </div>
        <div className="mt-1.5 text-[11px] font-mono text-ink-3 truncate">
          Reputation {reputationScore}
          {disputes > 0 ? ` · ${disputes} disputes` : ''}
        </div>
      </div>

      {/* ── Earned ────────────────────────────────────────────── */}
      {isOwner || servicesSold == null ? (
        <div className="p-5 min-w-0 overflow-hidden flex flex-col" style={{ background: 'rgba(16, 185, 129, 0.1)' }}>
          <div className="flex items-center gap-1.5 text-ok mb-2">
            <Icon name="chart" size={12} className="text-ok" />
            <span className="text-[10px] font-mono font-semibold uppercase tracking-widest truncate">
              Earned
            </span>
          </div>
          <div className="text-[28px] sm:text-[32px] font-mono font-bold text-ok leading-none tracking-tightest truncate">
            {earnedValue}
          </div>
          <div className="mt-1.5 text-[11px] font-mono text-ok truncate">
            lifetime
          </div>
        </div>
      ) : (
        <div className="p-5 min-w-0 overflow-hidden flex flex-col" style={{ background: 'rgba(16, 185, 129, 0.1)' }}>
          <div className="flex items-center gap-1.5 text-ok mb-2">
            <Icon name="briefcase" size={12} className="text-ok" />
            <span className="text-[10px] font-mono font-semibold uppercase tracking-widest truncate">
              Services sold
            </span>
          </div>
          <div className="text-[28px] sm:text-[32px] font-mono font-bold text-ok leading-none tracking-tightest truncate">
            {String(servicesSold)}
          </div>
          <div className="mt-1.5 text-[11px] font-mono text-ok truncate">
            {earnedValue} earned
          </div>
        </div>
      )}

      {/* ── Wallet Balance / On-chain ─────────────────────────── */}
      {isOwner ? (
        <div
          className="p-5 min-w-0 overflow-hidden flex flex-col"
          style={{
            background: isLowGas
              ? 'rgba(245, 158, 11, 0.1)'
              : 'var(--bb-surface)',
          }}
        >
          <div className={`flex items-center gap-1.5 mb-2 ${isLowGas ? 'text-warn' : 'text-ink-3'}`}>
            <Icon name="wallet" size={12} className={isLowGas ? 'text-warn' : 'text-ink-3'} />
            <span className="text-[10px] font-mono font-semibold uppercase tracking-widest truncate">
              Wallet
            </span>
          </div>
          <div className="text-[28px] sm:text-[32px] font-mono font-bold text-ink leading-none tracking-tightest truncate">
            {balanceEther > 0 ? balanceEther.toFixed(4) : '—'}
          </div>
          <div className="mt-1.5 text-[11px] font-mono text-ink-3 truncate">
            {symbol}
          </div>
          {isLowGas && (
            <div className="mt-2">
              <Button
                variant="outline"
                size="sm"
                label="Fund"
                className="!border-warn !text-warn hover:!bg-warn/10"
                onClick={onFund}
              />
            </div>
          )}
        </div>
      ) : (
        <div className="card-dark p-5 min-w-0 overflow-hidden flex flex-col justify-center">
          <div className="flex items-center gap-1.5 text-ink-3 mb-2">
            <Icon name="wallet" size={12} className="text-ink-3" />
            <span className="text-[10px] font-mono font-semibold uppercase tracking-widest truncate">
              On-chain
            </span>
          </div>
          {walletAddress ? (
            <>
              <div className="font-mono text-sm text-ink truncate" title={walletAddress}>{truncateAddress(walletAddress)}</div>
              <ExplorerAddressLinks
                address={walletAddress}
                className="mt-1 font-mono text-[11px] uppercase tracking-widest text-ink-3"
              />
            </>
          ) : (
            <div className="font-mono text-sm text-ink-3">—</div>
          )}
        </div>
      )}
    </div>
  );
}
