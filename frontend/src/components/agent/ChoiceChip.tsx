import type { ReactNode } from 'react';

/** Pill selectable chip, the one styling used for capability picks and
 *  service-type picks. Selected takes the invert fill, like bb Segmented. */
export function ChoiceChip({
  selected,
  onClick,
  children,
  label,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
  label?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={label}
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-xs border transition-colors ${
        selected
          ? 'bg-invert border-invert text-invert-fg'
          : 'bg-surface-2 border-line text-ink-3 hover:text-ink-2 hover:border-line-2'
      }`}
    >
      {children}
    </button>
  );
}
