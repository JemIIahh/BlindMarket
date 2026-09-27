interface HighlightCardProps {
  children: React.ReactNode;
  className?: string;
  padding?: 'sm' | 'md' | 'lg';
}

/** The one highlighted card on a page: the invert card, as on the landing
 * (near-black on paper, cream on dark). Inside it the ink, line and accent
 * tokens flip, so text-ink / text-ink-3 / text-accent read on the fill. */
export function HighlightCard({ children, className = '', padding = 'md' }: HighlightCardProps) {
  const pad = { sm: 'p-4', md: 'p-7', lg: 'p-10' }[padding];
  return <div className={`bb-highlight rounded-2xl ${pad} ${className}`}>{children}</div>;
}
