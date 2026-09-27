import { Fragment } from 'react';

interface BreadcrumbProps {
  items: string[];
}

/** snake_case / lowercase token → sentence case ("how_it_works" → "How it works"). */
function fmt(s: string): string {
  const t = s.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function Breadcrumb({ items }: BreadcrumbProps) {
  return (
    <nav className="flex items-center flex-wrap gap-x-2 gap-y-1 text-xs text-ink-3 mb-3">
      {items.map((item, i) => {
        const last = i === items.length - 1;
        return (
          <Fragment key={`${item}-${i}`}>
            <span className={last ? 'text-ink-2' : ''}>{fmt(item)}</span>
            {!last && <span className="text-[color-mix(in_srgb,var(--bb-ink-3)_50%,transparent)]">/</span>}
          </Fragment>
        );
      })}
    </nav>
  );
}
