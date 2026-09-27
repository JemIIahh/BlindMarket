import { useRef, type KeyboardEvent } from 'react';

/**
 * A form choice between a few options, as a pill toggle sized like Segmented.
 * Segmented is a filter (aria-pressed buttons); this is a radio group for
 * forms, with the WAI-ARIA radio keyboard pattern: one tab stop on the checked
 * option, and the arrow keys (Home/End too) move the choice. `disabled` locks
 * it, e.g. while a post is being sent.
 */
export function RadioPills<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  className = '',
}: {
  /** The group's accessible name, e.g. "Privacy". */
  label: string;
  value: T;
  options: ReadonlyArray<readonly [T, string]>;
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const checkedIndex = options.findIndex(([option]) => option === value);

  const choose = (index: number) => {
    const next = (index + options.length) % options.length;
    onChange(options[next][0]);
    refs.current[next]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (disabled) return;
    const moves: Record<string, number> = {
      ArrowRight: index + 1,
      ArrowDown: index + 1,
      ArrowLeft: index - 1,
      ArrowUp: index - 1,
      Home: 0,
      End: options.length - 1,
    };
    if (event.key in moves) {
      event.preventDefault();
      choose(moves[event.key]);
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={`inline-flex flex-wrap gap-1 rounded-full border border-line bg-surface-2 p-1 ${className}`}
    >
      {options.map(([option, text], index) => {
        const active = index === checkedIndex;
        // One tab stop: the checked option, or the first when none is.
        const tabbable = checkedIndex === -1 ? index === 0 : active;
        return (
          <button
            key={option}
            ref={(el) => { refs.current[index] = el; }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={tabbable ? 0 : -1}
            onClick={() => { if (!disabled) onChange(option); }}
            onKeyDown={(event) => onKeyDown(event, index)}
            disabled={disabled}
            className={`inline-flex h-8 items-center whitespace-nowrap rounded-full px-3.5 text-[13px] font-medium transition-colors duration-240 ease-bb disabled:cursor-not-allowed ${
              active ? 'bg-invert text-invert-fg' : 'text-ink-3 hover:text-ink'
            }`}
          >
            {text}
          </button>
        );
      })}
    </div>
  );
}
