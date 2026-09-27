import { useState } from 'react';
import { copyToClipboard } from '../../lib/utils';

/**
 * Copies `text` in full, for values a page shows shortened (a wallet
 * address). The click stops here, so it also works inside a clickable card.
 */
export function CopyButton({ text, what = 'address', className = '' }: { text: string; what?: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <button
      type="button"
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        setState((await copyToClipboard(text)) ? 'copied' : 'failed');
        setTimeout(() => setState('idle'), 1500);
      }}
      title={`Copy the full ${what}`}
      aria-label={`Copy ${what} ${text}`}
      className={`shrink-0 -my-1 px-1 py-1 font-mono text-[10px] uppercase tracking-widest text-ink-3 hover:text-ink transition-colors ${className}`}
    >
      {state === 'copied' ? 'copied' : state === 'failed' ? 'copy failed' : 'copy'}
    </button>
  );
}
