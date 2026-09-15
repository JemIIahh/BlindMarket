import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Panel, Button, FormTextarea } from './bb';
import { truncateAddress } from '../lib/utils';
import { getMyTaskReview, submitReview, type AgentReview } from '../services/marketplace';

/**
 * "Rate your agent" — lives on the completed task page, where the taskId the
 * backend requires is known. Reviews are poster-only, executor-matched, and
 * one-per-task (enforced server-side); this panel just makes that path
 * reachable. The old agent-page form submitted taskId:'' and could never
 * succeed, so the form lives here now.
 */
export function RateAgent({
  taskHash,
  executorAddress,
}: {
  taskHash: string;
  executorAddress: string;
}) {
  const [existing, setExisting] = useState<AgentReview | null | undefined>(undefined);
  const [rating, setRating] = useState(5);
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    // a2a store keys are lowercase hashes — match them exactly so a
    // checksummed URL hash still finds the row.
    getMyTaskReview(taskHash.toLowerCase())
      .then((d) => {
        if (!cancelled) setExisting(d.review);
      })
      .catch(() => {
        // Non-blocking: a failed check just shows the form; submit carries
        // the real authorization and surfaces ALREADY_REVIEWED if needed.
        if (!cancelled) setExisting(null);
      });
    return () => {
      cancelled = true;
    };
  }, [taskHash]);

  async function handleSubmit() {
    setSubmitting(true);
    setError('');
    try {
      const r = await submitReview({
        taskId: taskHash.toLowerCase(),
        agentAddress: executorAddress,
        rating,
        review: text.trim() || undefined,
      });
      setExisting(r);
      setText('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  if (existing === undefined) return null;

  return (
    <Panel padding="md" className="mb-6">
      <h3 className="text-sm font-semibold text-ink mb-1">Rate your agent</h3>
      {existing ? (
        <p className="text-sm text-ink-2 leading-relaxed">
          <span className="text-cream font-mono">
            {'★'.repeat(existing.rating)}{'☆'.repeat(5 - existing.rating)}
          </span>{' '}
          — thanks, your review is live on{' '}
          <Link
            to={`/agents/${executorAddress}`}
            className="text-cream hover:underline decoration-cream/30"
          >
            {truncateAddress(executorAddress)}'s profile
          </Link>
          .
        </p>
      ) : (
        <>
          <p className="text-xs text-ink-3 mb-3 leading-relaxed">
            How did <span className="font-mono text-ink-2">{truncateAddress(executorAddress)}</span> do?
            Your rating is public on their profile.
          </p>
          <div className="flex items-center gap-1 mb-3">
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                key={star}
                type="button"
                aria-label={`Rate ${star} out of 5`}
                onClick={() => setRating(star)}
                className={`text-xl transition-colors ${star <= rating ? 'text-cream' : 'text-ink-3 hover:text-ink-2'}`}
              >
                ★
              </button>
            ))}
            <span className="text-xs text-ink-3 ml-1">{rating}/5</span>
          </div>
          <FormTextarea
            rows={2}
            placeholder="What went well? (optional)"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="mb-3"
          />
          <Button
            variant="primary"
            size="sm"
            label={submitting ? 'Submitting…' : 'Submit review'}
            disabled={submitting}
            onClick={handleSubmit}
          />
          {error && <p className="text-xs text-err mt-2 font-mono">{error}</p>}
        </>
      )}
    </Panel>
  );
}
