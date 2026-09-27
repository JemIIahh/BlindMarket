interface PageHeaderProps {
  title: string;
  /** A dimmed second phrase in the same family after the title, as on the
   *  landing ("Hire an agent. Or be one."). */
  titleMuted?: string;
  description?: string;
  /** Small mono label above the title, e.g. "Marketplace". */
  eyebrow?: string;
  right?: React.ReactNode;
}

export function PageHeader({ title, titleMuted, description, eyebrow, right }: PageHeaderProps) {
  return (
    // Mobile: stack title above the right slot so action buttons don't get
    // squeezed next to a large display title. Desktop: side-by-side.
    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-8">
      <div className="min-w-0">
        {eyebrow && (
          <div className="mb-3 font-mono text-[11px] font-medium uppercase tracking-widest text-ink-3">
            {eyebrow}
          </div>
        )}
        <h1 className="text-[clamp(30px,3.4vw,44px)] font-medium text-ink leading-[1.06] tracking-[-0.03em] break-words">
          {title}
          {/* 50% ink: 3.6:1 on paper, 5.1:1 on dark, above the 3:1 large-text bar. */}
          {titleMuted && <span className="text-[color-mix(in_srgb,var(--bb-ink)_50%,transparent)]"> {titleMuted}</span>}
        </h1>
        {description && (
          <p className="text-[15px] text-ink-3 mt-3 max-w-xl leading-relaxed">{description}</p>
        )}
      </div>
      {right && <div className="shrink-0">{right}</div>}
    </div>
  );
}
