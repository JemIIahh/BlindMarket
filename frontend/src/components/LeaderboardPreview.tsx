import { Link } from 'react-router-dom';
import { useLeaderboard } from '../hooks/useReputation';
import { Tag } from './bb';
import { truncateAddress } from '../lib/utils';

/**
 * Compact leaderboard surface for the landing page. Shows the top N agents
 * by decayed reputation, each row a single line. Standalone full view lives
 * at /leaderboard (Leaderboard.tsx) — this is just the social-proof preview.
 */
export function LeaderboardPreview({ limit = 5 }: { limit?: number }) {
  const { data, isLoading } = useLeaderboard(limit);
  const leaderboard = data?.leaderboard ?? [];

  return (
    <div className="border border-line bg-surface">
      <div className="grid grid-cols-[40px_1fr_90px_70px] gap-4 px-5 py-3 border-b border-line text-[10px] font-mono font-semibold uppercase tracking-widest text-ink-3">
        <span>#</span>
        <span>identity</span>
        <span className="text-right">score</span>
        <span className="text-right">status</span>
      </div>

      {isLoading ? (
        <div className="px-5 py-12 text-center text-xs font-mono text-ink-3">loading network data…</div>
      ) : leaderboard.length === 0 ? (
        <div className="px-5 py-12 text-center text-xs font-mono text-ink-3">no reputation data yet — be the first</div>
      ) : (
        leaderboard.map((entry, i) => {
          const decay = entry.decayFactor ?? 1;
          const active = decay > 0.5;
          return (
            <div
              key={entry.address}
              className="grid grid-cols-[40px_1fr_90px_70px] gap-4 px-5 py-3 border-b border-line last:border-b-0 text-[12px] font-mono items-center"
            >
              <span className="text-ink-3">#{i + 1}</span>
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-5 h-5 bg-surface-2 border border-line flex items-center justify-center text-[9px] font-bold text-ink-3 shrink-0">
                  {entry.address.slice(2, 4).toUpperCase()}
                </div>
                <span className="text-ink truncate">{truncateAddress(entry.address)}</span>
              </div>
              <div className="text-right">
                <span className="text-ink font-bold">{entry.decayedScore.toFixed(1)}</span>
                <span className={`ml-1 ${decay > 0.9 ? 'text-ok' : decay > 0.5 ? 'text-warn' : 'text-err'}`}>
                  {decay > 0.9 ? '↑' : decay > 0.5 ? '→' : '↓'}
                </span>
              </div>
              <div className="flex justify-end">
                <Tag tone={active ? 'ok' : 'neutral'}>{decay > 0.9 ? 'active' : 'dormant'}</Tag>
              </div>
            </div>
          );
        })
      )}

      <div className="px-5 py-3 border-t border-line bg-surface-2 flex justify-center">
        <Link to="/leaderboard" className="text-[11px] font-mono text-cream hover:underline uppercase tracking-widest">
          view full leaderboard →
        </Link>
      </div>
    </div>
  );
}
