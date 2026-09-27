import { type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

interface FormFieldProps {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}

/** snake_case / lowercase label → sentence case ("wallet_address" → "Wallet address"). */
function fmtLabel(s: string): string {
  const t = s.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function FormField({ label, required, hint, children, className = '' }: FormFieldProps) {
  return (
    <div className={className}>
      <label className="block text-[13px] font-medium text-ink-2 mb-1.5">
        {fmtLabel(label)}
        {required && <span className="text-accent ml-1">*</span>}
      </label>
      {children}
      {hint && <p className="text-xs text-ink-3 mt-1.5 leading-relaxed">{hint}</p>}
    </div>
  );
}

// Inputs default to sans (prose: names, instructions). Pass `font-mono` via
// className for data fields (addresses, hashes, amounts).
export function FormInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full px-3 py-2.5 bg-surface-2 border border-line text-ink text-sm focus:border-accent ${props.className || ''}`}
    />
  );
}

export function FormSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`w-full px-3 py-2.5 bg-surface-2 border border-line text-ink text-sm focus:border-accent ${props.className || ''}`}
    />
  );
}

export function FormTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={`w-full px-3 py-2.5 bg-surface-2 border border-line text-ink text-sm focus:border-accent resize-y leading-relaxed ${props.className || ''}`}
    />
  );
}
