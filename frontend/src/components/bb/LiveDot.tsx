/** Square accent dot with a soft expanding ring: "this is live". Decorative
 * unless given a label, which makes it an announced status. */
export function LiveDot({ label, className = '' }: { label?: string; className?: string }) {
  return label ? (
    <span role="status" aria-label={label} title={label} className={`bb-live-dot ${className}`} />
  ) : (
    <span aria-hidden className={`bb-live-dot ${className}`} />
  );
}
