interface SegmentedOption<T extends string> {
  id: T;
  label: string;
  /** Shown after the label in mono, e.g. how many rows the filter keeps. */
  count?: number;
}

/** Pill segmented control for filters: the landing's FAQ pills in one
 * track. The chosen option takes the invert fill. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  className = '',
}: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (next: T) => void;
  /** Accessible name for the group, e.g. "Filter by privacy". */
  label: string;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={`inline-flex max-w-full items-center gap-1 overflow-x-auto rounded-full border border-line bg-surface p-1 ${className}`}>
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.id)}
            className={`inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-[13px] font-medium transition-colors duration-240 ease-bb ${
              on ? 'bg-invert text-invert-fg' : 'text-ink-3 hover:text-ink'
            }`}
          >
            {o.label}
            {o.count != null && (
              <span className={`font-mono text-[11px] tabular-nums ${on ? 'opacity-70' : ''}`}>{o.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
