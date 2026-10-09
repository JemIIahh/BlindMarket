import { type ReactNode } from 'react';
import { Icon } from './Icon';
import { Tag } from './Tag';

/**
 * Shared state + status primitives for the internal app, so every page shows
 * loading / empty / status the same way instead of ad-hoc "loading…" text and
 * mismatched status colours.
 */

/** Spinner — an SVG ring with an accent arc. */
export function Spinner({ size = 16, className = '' }: { size?: number; className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="var(--bb-line)" strokeWidth="2.5" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="var(--bb-cream)" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

/** Shimmering placeholder block. */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`bb-shimmer rounded-md ${className}`} aria-hidden />;
}

/** Centered loading indicator: an accent light sweeping a hairline. */
export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div role="status" className="flex flex-col items-center justify-center gap-3 py-16 text-sm text-ink-3">
      <div className="bb-scan w-40" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

/** Friendly, actionable empty state. */
export function EmptyState({
  icon = 'list',
  title,
  description,
  action,
}: {
  icon?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-16 px-6">
      <div className="w-11 h-11 rounded-full border border-line flex items-center justify-center text-ink-3 mb-4">
        <Icon name={icon} size={20} />
      </div>
      <p className="text-sm font-medium text-ink">{title}</p>
      {description && <p className="text-xs text-ink-3 mt-1.5 max-w-xs leading-relaxed">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/** Error state — a load failed; offers a retry when the caller can refetch. */
export function ErrorState({
  title = "Couldn't load this",
  description = 'Something went wrong reaching the marketplace. Check your connection and try again.',
  onRetry,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-16 px-6">
      <div className="w-11 h-11 rounded-full border border-[color-mix(in_srgb,var(--bb-err)_40%,transparent)] flex items-center justify-center text-err mb-4">
        <Icon name="alert" size={20} />
      </div>
      <p className="text-sm font-medium text-ink">{title}</p>
      {description && <p className="text-xs text-ink-3 mt-1.5 max-w-xs leading-relaxed">{description}</p>}
      {onRetry && (
        <button
          onClick={onRetry}
          className="bb-btn bb-btn-secondary mt-5 h-9 px-4 text-[13px]"
        >
          Retry
        </button>
      )}
    </div>
  );
}

// ── Semantic status → tone ───────────────────────────────────────────
type Tone = 'ok' | 'warn' | 'err' | 'info' | 'neutral' | 'accent';

const STATUS_TONE: Record<string, Tone> = {
  // open for work — the accent, so available tasks stand out
  open: 'accent', posted: 'accent', funded: 'accent', collecting: 'accent', taking_submissions: 'accent',
  // in flight or awaiting a verdict — someone is on it
  assigned: 'info', accepted: 'info', in_progress: 'info', executing: 'info',
  active: 'info', submitted: 'info', verifying: 'info', pending: 'info',
  awaiting_verification: 'info', picking_winner: 'info',
  // needs the owner's attention
  paused: 'warn',
  // done — green
  completed: 'ok', verified: 'ok', settled: 'ok', paid: 'ok', success: 'ok', running: 'ok',
  // failed — red. The plain 'verified' key above is the OFF-chain a2a status
  // (means passed); on-chain TaskStatus.Verified means "verified and FAILED"
  // and reaches us as the label 'Verification failed'.
  failed: 'err', verification_failed: 'err', disputed: 'err', error: 'err',
  // over without a result — muted, not an error
  expired: 'neutral', cancelled: 'neutral', canceled: 'neutral', refunded: 'neutral',
  waiting: 'neutral', idle: 'neutral', stopped: 'neutral',
};

export function statusTone(status?: string): Tone {
  if (!status) return 'neutral';
  return STATUS_TONE[status.toLowerCase().replace(/[\s-]+/g, '_')] ?? 'neutral';
}

/** A status chip whose colour is derived semantically from the status string. */
export function StatusTag({ status }: { status?: string }) {
  if (!status) return null;
  return <Tag tone={statusTone(status)}>{status.replace(/_/g, ' ')}</Tag>;
}
