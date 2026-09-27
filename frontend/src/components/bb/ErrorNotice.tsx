import { useState } from 'react';
import { Icon } from './Icon';
import { copyToClipboard } from '../../lib/utils';
import { friendlyError, type FriendlyErrorKind } from '../../lib/friendlyError';

/**
 * An error, in words: what happened and what to do, with the raw text folded
 * away under "Show details" for a support ticket. Takes whatever was thrown
 * (or a message string); renders nothing for an empty value.
 *
 * Colours come from the status tokens through inline color-mix: a Tailwind
 * opacity modifier on a var() colour generates no CSS.
 */

const TONE: Record<FriendlyErrorKind, { color: string; icon: string }> = {
  cancelled: { color: 'var(--bb-ink-3)', icon: 'x' },
  funds: { color: 'var(--bb-warn)', icon: 'wallet' },
  chain: { color: 'var(--bb-warn)', icon: 'alert' },
  network: { color: 'var(--bb-warn)', icon: 'alert' },
  revert: { color: 'var(--bb-err)', icon: 'alert' },
  server: { color: 'var(--bb-err)', icon: 'alert' },
  unknown: { color: 'var(--bb-err)', icon: 'alert' },
  maybeSent: { color: 'var(--bb-warn)', icon: 'clock' },
  outdated: { color: 'var(--bb-ink-3)', icon: 'bolt' },
};

export function ErrorNotice({
  error,
  title,
  network,
  gasToken,
  compact = false,
  className = '',
}: {
  error: unknown;
  /** Title when the error isn't a recognised kind, e.g. "Couldn't withdraw". */
  title?: string;
  /** Network the action targets, for the "switch your wallet" hint. */
  network?: string;
  /** The coin that pays the network fee, when it isn't USDC. */
  gasToken?: string;
  /** One line with no box, for table rows and tight spots. */
  compact?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  if (error === null || error === undefined || error === '' || error === false) return null;

  const f = friendlyError(error, { title, network, gasToken });
  const tone = TONE[f.kind];
  const role = f.kind === 'cancelled' ? 'status' : 'alert';

  const details = f.details && (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="font-mono text-[10px] uppercase tracking-widest text-ink-3 hover:text-ink transition-colors"
      >
        {open ? 'Hide details' : 'Show details'}
      </button>
      {open && (
        <div className="mt-1.5 flex items-start gap-2">
          <pre className="flex-1 min-w-0 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-[10.5px] leading-relaxed text-ink-3 bg-surface-2 border border-line rounded-lg px-2.5 py-1.5">
            {f.details}
          </pre>
          <button
            type="button"
            onClick={async () => {
              setCopied((await copyToClipboard(f.details ?? '')) ? 'copied' : 'failed');
              setTimeout(() => setCopied('idle'), 1500);
            }}
            aria-label="Copy error details"
            className="shrink-0 py-1 font-mono text-[10px] uppercase tracking-widest text-ink-3 hover:text-ink transition-colors"
          >
            {copied === 'copied' ? 'copied' : copied === 'failed' ? 'copy failed' : 'copy'}
          </button>
        </div>
      )}
    </div>
  );

  if (compact) {
    return (
      <div role={role} className={`text-xs leading-relaxed break-words ${className}`}>
        <span className="inline-flex align-[-2px] mr-1.5" style={{ color: tone.color }}>
          <Icon name={tone.icon} size={13} />
        </span>
        <span className="font-medium text-ink">{f.title}.</span>{' '}
        <span className="text-ink-2">{f.message}</span>
        {details}
      </div>
    );
  }

  return (
    <div
      role={role}
      className={`flex gap-2.5 rounded-xl border px-3.5 py-3 text-left ${className}`}
      style={{
        borderColor: `color-mix(in srgb, ${tone.color} 40%, transparent)`,
        background: `color-mix(in srgb, ${tone.color} 7%, transparent)`,
      }}
    >
      <span className="mt-px shrink-0" style={{ color: tone.color }}>
        <Icon name={tone.icon} size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink">{f.title}</p>
        <p className="text-xs text-ink-2 mt-0.5 leading-relaxed break-words">{f.message}</p>
        {details}
      </div>
    </div>
  );
}
