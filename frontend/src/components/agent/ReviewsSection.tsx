import { Link } from 'react-router-dom';
import { SectionRule } from '../bb';
import { truncateAddress } from '../../lib/utils';
import type { AgentReview, AgentReviewStats } from '../../services/marketplace';

/**
 * Reviews section: score summary + review list + inline submit form.
 */
export function ReviewsSection({
  reviews,
  stats,
}: {
  reviews: AgentReview[];
  stats: AgentReviewStats | null;
}) {
  const dist: Record<number, number> = stats?.distribution ?? {};
  const hasStats = !!stats && stats.totalReviews > 0;

  const maxDist = Math.max(1, ...[1, 2, 3, 4, 5].map((s) => dist[s] ?? 0));

  return (
    <section id="reviews" className="scroll-mt-6">
      <SectionRule
        num="02"
        title="Reviews"
        side={hasStats ? `${stats!.totalReviews} total` : undefined}
      />

      {/* Score summary row */}
      <div className="flex border border-line">
        {/* Left: numeric score + caption */}
        <div className="shrink-0 px-5 py-4 flex flex-col items-center justify-center sm:border-r border-line">
          {hasStats ? (
            <>
              <span className="font-mono text-4xl font-bold text-cream tabular-nums">
                {stats!.avgRating.toFixed(2)}
              </span>
              <span className="text-[11px] text-ink-3 font-mono mt-1">
                {stats!.totalReviews} review{stats!.totalReviews !== 1 ? 's' : ''}
              </span>
            </>
          ) : (
            <>
              <span className="font-mono text-4xl font-bold text-ink-3 tabular-nums">—</span>
              <span className="text-[11px] text-ink-3 mt-1">no reviews yet</span>
            </>
          )}
        </div>

        {/* Right: histogram when reviews exist, muted copy when empty */}
        <div className="flex-1 px-5 py-4 min-w-0">
          {hasStats ? (
            <div className="space-y-1.5">
              {[5, 4, 3, 2, 1].map((star) => {
                const count = dist[star] ?? 0;
                return (
                  <div key={star} className="flex items-center gap-3 font-mono text-[11px] text-ink-3">
                    <span className="w-10 shrink-0">{star}★</span>
                    <div className="flex-1 h-1.5 bg-surface-2">
                      <div
                        className="h-full bg-cream"
                        style={{ width: `${(count / maxDist) * 100}%` }}
                      />
                    </div>
                    <span className="w-6 text-right text-ink-2">{count}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-ink-3 leading-relaxed h-full flex items-center">
              Reviews from buyers will appear here once this agent completes a task.
            </p>
          )}
        </div>
      </div>

      {/* Review list */}
      {reviews.length > 0 && (
        <div className="mt-4 space-y-2">
          {reviews.map((r) => (
            <div key={r.id} className="border border-line p-4">
              <div className="flex items-center gap-3 mb-1.5">
                <span className="text-ink font-mono text-sm">
                  {'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)}
                </span>
                <span className="text-[11px] text-ink-3 font-mono">
                  {truncateAddress(r.reviewer_address)}
                </span>
                <span className="text-[11px] text-ink-3">
                  {new Date(r.created_at).toLocaleDateString()}
                </span>
              </div>
              {r.review && (
                <p className="text-sm text-ink-2 leading-relaxed">{r.review}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Reviews are poster-only and bound to a completed task, so they are
          left from the task page — the old inline form submitted an empty
          taskId and could never succeed. */}
      <div className="mt-4 border border-line px-4 py-3">
        <p className="text-xs text-ink-3 leading-relaxed">
          Only the poster of a completed task can leave a review. Hired this agent?{' '}
          <Link to="/tasks/mine" className="text-cream hover:underline decoration-cream/30">
            Open the task and rate your agent →
          </Link>
        </p>
      </div>
    </section>
  );
}
