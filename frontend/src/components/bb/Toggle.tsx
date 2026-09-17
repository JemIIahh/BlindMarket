interface ToggleProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  disabled?: boolean;
  className?: string;
}

export function Toggle({ checked, onChange, label, disabled, className = '' }: ToggleProps) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative shrink-0 w-[38px] h-[22px] rounded-full border transition-colors flex items-center before:absolute before:-inset-x-1.5 before:-inset-y-3 before:content-[''] disabled:opacity-40 disabled:cursor-not-allowed ${
        checked ? 'bg-ok/20 border-ok/40' : 'bg-surface-2 border-line'
      } ${className}`}
    >
      <div
        className={`w-[18px] h-[18px] rounded-full transition-transform ${
          checked ? 'translate-x-[18px] bg-ok' : 'translate-x-[1px] bg-ink-3'
        }`}
      />
    </button>
  );
}
