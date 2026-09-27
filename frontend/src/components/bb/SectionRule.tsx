interface SectionRuleProps {
  num: string;
  title: string;
  side?: string;
  className?: string;
}

export function SectionRule({ num, title, side, className = '' }: SectionRuleProps) {
  return (
    <div className={`flex items-center gap-3 mb-5 ${className}`}>
      <span className="text-xs font-mono text-accent">{num}</span>
      <span className="text-sm font-semibold text-ink">{title}</span>
      <span className="flex-1 h-px bg-line" />
      {side && <span className="text-xs text-ink-3 shrink-0">{side}</span>}
    </div>
  );
}
