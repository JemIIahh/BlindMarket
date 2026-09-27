interface TagProps {
  tone?: 'ok' | 'warn' | 'err' | 'info' | 'neutral' | 'accent';
  children: React.ReactNode;
  className?: string;
}

// Static map, NOT `chip-${tone}`: Tailwind's content scanner can't see
// runtime-built class names, so the dynamic form got the color variants
// purged from the production bundle (chips rendered colorless).
const TONE_CLASS: Record<NonNullable<TagProps['tone']>, string> = {
  ok: 'chip-ok',
  warn: 'chip-warn',
  err: 'chip-err',
  info: 'chip-info',
  neutral: 'chip-neutral',
  accent: 'chip-accent',
};

export function Tag({ tone = 'neutral', children, className = '' }: TagProps) {
  return (
    <span className={`chip ${TONE_CLASS[tone]} ${className}`}>
      {children}
    </span>
  );
}
