interface PaginationProps {
  page: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  className?: string;
}

/** Build the page number array with ellipsis markers.
 *  Shows: first, (current-1)..(current+1), last — with '…' gaps. */
function pageNumbers(current: number, total: number): (number | '…')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages: (number | '…')[] = [1];
  if (current > 3) pages.push('…');
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  for (let i = start; i <= end; i++) pages.push(i);
  if (current < total - 2) pages.push('…');
  pages.push(total);
  return pages;
}

export function Pagination({ page, totalPages, totalItems, pageSize, onPageChange, className = '' }: PaginationProps) {
  if (totalItems <= pageSize) return null;

  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, totalItems);
  const pages = pageNumbers(page, totalPages);

  return (
    <div className={`flex items-center justify-between px-4 py-3 border-t border-line text-xs ${className}`}>
      <span className="text-ink-3">
        Showing {from}–{to} of {totalItems}
      </span>
      <div className="flex items-center gap-1">
        <button
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          className="w-8 h-8 flex items-center justify-center border border-line bg-surface-2 hover:bg-surface-3 disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-ink-3"
          aria-label="Previous page"
        >
          ‹
        </button>
        {pages.map((p, i) =>
          p === '…' ? (
            <span key={`e${i}`} className="w-8 h-8 flex items-center justify-center text-ink-3">…</span>
          ) : (
            <button
              key={p}
              onClick={() => onPageChange(p)}
              className={`w-8 h-8 flex items-center justify-center border transition-colors ${
                p === page
                  ? 'bg-cream text-bg border-cream font-medium'
                  : 'border-line bg-surface-2 hover:bg-surface-3 text-ink-3 hover:text-ink'
              }`}
            >
              {p}
            </button>
          )
        )}
        <button
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
          className="w-8 h-8 flex items-center justify-center border border-line bg-surface-2 hover:bg-surface-3 disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-ink-3"
          aria-label="Next page"
        >
          ›
        </button>
      </div>
    </div>
  );
}
