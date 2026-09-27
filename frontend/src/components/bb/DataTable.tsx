import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { LoadingState, EmptyState, ErrorState } from './states';

/**
 * One responsive table for the whole internal app — a grid table on desktop,
 * stacked cards on mobile — so every list (marketplace, my tasks, my agents,
 * ledger…) looks and behaves the same instead of each page re-implementing a
 * `hidden md:block` table + `md:hidden` cards.
 *
 * Columns describe both layouts. On mobile, the `primary` column is the card
 * title (top-left) and the `trailing` column sits top-right (usually status);
 * the rest render as label/value rows.
 */
export interface Column<T> {
  key: string;
  header: string;
  /** CSS grid track for desktop, e.g. '120px' or '1fr'. Defaults to '1fr'. */
  width?: string;
  align?: 'left' | 'right';
  cell: (row: T) => ReactNode;
  /** Mobile card title (top-left). */
  primary?: boolean;
  /** Mobile top-right slot (usually status). */
  trailing?: boolean;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[] | undefined;
  rowKey: (row: T) => string;
  rowHref?: (row: T) => string;
  loading?: boolean;
  loadingLabel?: string;
  /** When true, renders an error state (with optional retry) instead of rows/empty. */
  error?: boolean;
  onRetry?: () => void;
  empty?: { icon?: string; title: string; description?: string; action?: ReactNode };
  className?: string;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  rowHref,
  loading,
  loadingLabel,
  error,
  onRetry,
  empty,
  className = '',
}: DataTableProps<T>) {
  const template = columns.map((c) => c.width || '1fr').join(' ');
  const primary = columns.find((c) => c.primary) ?? columns[0];
  const trailing = columns.find((c) => c.trailing);
  const detailCols = columns.filter((c) => c !== primary && c !== trailing);

  return (
    <div className={`overflow-hidden rounded-2xl border border-line bg-surface ${className}`}>
      {loading ? (
        <LoadingState label={loadingLabel} />
      ) : error ? (
        <ErrorState onRetry={onRetry} />
      ) : !rows || rows.length === 0 ? (
        empty ? <EmptyState {...empty} /> : <div className="py-12 text-center text-sm text-ink-3">Nothing here yet.</div>
      ) : (
        <>
          {/* Desktop */}
          <div className="hidden md:block overflow-x-auto">
            <div
              className="grid gap-6 px-5 py-3 border-b border-line text-[11px] font-medium uppercase tracking-wider text-ink-3"
              style={{ gridTemplateColumns: template }}
            >
              {columns.map((c) => (
                <span key={c.key} className={c.align === 'right' ? 'text-right' : ''}>{c.header}</span>
              ))}
            </div>
            {rows.map((row) => {
              const cells = (
                <>
                  {columns.map((c) => (
                    <span key={c.key} className={`min-w-0 truncate ${c.align === 'right' ? 'text-right' : ''}`}>
                      {c.cell(row)}
                    </span>
                  ))}
                </>
              );
              const base = 'grid gap-6 px-5 py-3.5 border-b border-line last:border-b-0 text-sm items-center';
              return rowHref ? (
                <Link
                  key={rowKey(row)}
                  to={rowHref(row)}
                  className={`${base} hover:bg-surface-2 transition-colors`}
                  style={{ gridTemplateColumns: template }}
                >
                  {cells}
                </Link>
              ) : (
                <div key={rowKey(row)} className={base} style={{ gridTemplateColumns: template }}>
                  {cells}
                </div>
              );
            })}
          </div>

          {/* Mobile */}
          <div className="md:hidden divide-y divide-line">
            {rows.map((row) => {
              const inner = (
                <div className="px-5 py-4 space-y-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 text-sm text-ink truncate">{primary.cell(row)}</div>
                    {trailing && <div className="shrink-0">{trailing.cell(row)}</div>}
                  </div>
                  {detailCols.map((c) => (
                    <div key={c.key} className="flex items-baseline justify-between gap-3">
                      <span className="text-[11px] uppercase tracking-wider text-ink-3 shrink-0">{c.header}</span>
                      <span className="text-sm text-ink-2 min-w-0 truncate text-right">{c.cell(row)}</span>
                    </div>
                  ))}
                </div>
              );
              return rowHref ? (
                <Link key={rowKey(row)} to={rowHref(row)} className="block hover:bg-surface-2 transition-colors">
                  {inner}
                </Link>
              ) : (
                <div key={rowKey(row)}>{inner}</div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
