import { useState } from 'react';
import { SectionRule, Button, FormInput, FormTextarea } from '../bb';
import { truncateAddress } from '../../lib/utils';
import { submitReview } from '../../services/marketplace';
import type { AgentReview, AgentReviewStats } from '../../services/marketplace';

/**
 * Reviews section: score summary + review list + inline submit form.
 */
export function ReviewsSection({
  agentWallet,
  reviews,
  stats,
  onSubmitted,
}: {
  agentWallet?: string;
  reviews: AgentReview[];
  stats: AgentReviewStats | null;
  onSubmitted: () => Promise<void>;
}) {
  const [rating, setRating] = useState(5);
  const [text, setText] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const dist: Record<number, number> = stats?.distribution ?? {};
  const hasStats = !!stats && stats.totalReviews > 0;

  async function handleSubmit() {
    if (!agentWallet) return;
    setSubmitting(true);
    setSubmitError('');
    try {
      await submitReview({
        taskId: '',
        agentAddress: agentWallet,
        rating,
        review: text.trim() || undefined,
      });
      setText('');
      setRating(5);
      setExpanded(false);
      await onSubmitted();
    } catch (err) {
      setSubmitError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

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

      {/* Submit review — inline row */}
      <div className="mt-4 border border-line p-4">
        <div className="flex items-center gap-3 flex-wrap">
          {/* Star picker */}
          <div className="flex items-center gap-0.5 shrink-0">
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                key={star}
                type="button"
                aria-label={`Rate ${star} out of 5`}
                onClick={() => setRating(star)}
                className={`text-lg transition-colors ${
                  star <= rating ? 'text-cream' : 'text-ink-3'
                }`}
              >
                ★
              </button>
            ))}
          </div>

          <span className="text-xs text-ink-3">{rating}/5</span>

          {/* Text input — single line by default, expands to textarea on focus if long */}
          {expanded ? (
            <FormTextarea
              rows={2}
              placeholder="Share your experience…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onBlur={() => {
                if (text.length <= 80) setExpanded(false);
              }}
              className="flex-1 min-w-0"
              autoFocus
            />
          ) : (
            <FormInput
              placeholder="Share your experience…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onFocus={() => {
                if (text.length > 80) setExpanded(true);
              }}
              className="flex-1 min-w-0"
            />
          )}

          {/* Submit */}
          <Button
            variant="primary"
            size="sm"
            label={submitting ? 'Submitting…' : 'Submit'}
            disabled={submitting || (!text.trim() && rating === 5)}
            onClick={handleSubmit}
          />
        </div>
        {submitError && (
          <p className="text-xs text-err mt-2">{submitError}</p>
        )}
      </div>
    </section>
  );
}
