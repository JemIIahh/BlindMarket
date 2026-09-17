import { type ReactNode, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './Button';

/**
 * bb/Modal — the one modal. Token-styled (sharp corners, line borders,
 * surface panel), portal-rendered, with escape/backdrop dismissal, focus
 * trap + restore, and body-scroll lock.
 *
 * Pass `dismissable={false}` for flows that must not be interrupted
 * (pending transactions, in-flight payments) — this removes the close
 * button and disables escape/backdrop close.
 */

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  /** Small mono line under the title (e.g. a price, an address). */
  subtitle?: ReactNode;
  children: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  dismissable?: boolean;
}

const SIZE = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-lg' } as const;

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  size = 'md',
  dismissable = true,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previousActive = useRef<Element | null>(null);

  useEffect(() => {
    if (!open || !dismissable) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, dismissable, onClose]);

  // Focus trap in + restore out, and lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    previousActive.current = document.activeElement;
    panelRef.current?.focus();
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = originalOverflow;
      if (previousActive.current instanceof HTMLElement) previousActive.current.focus();
    };
  }, [open]);

  const onTrapTab = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || !panelRef.current) return;
    const focusables = panelRef.current.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }, []);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 overflow-y-auto" role="dialog" aria-modal="true">
      <div
        className="fixed inset-0 bg-bg/80 backdrop-blur-sm"
        onClick={dismissable ? onClose : undefined}
        aria-hidden
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        onKeyDown={onTrapTab}
        className={`relative w-full ${SIZE[size]} border border-line bg-surface p-6 max-h-[90vh] supports-[height:100dvh]:max-h-[90dvh] overflow-y-auto focus:outline-none`}
      >
        {(title || dismissable) && (
          <div className="flex items-start justify-between gap-3 mb-4">
            <div className="min-w-0">
              {title && <h3 className="text-base font-semibold text-ink">{title}</h3>}
              {subtitle && <div className="font-mono text-xs text-ink-3 mt-0.5">{subtitle}</div>}
            </div>
            {dismissable && (
              <button
                onClick={onClose}
                aria-label="Close"
                className="p-2 -m-2 text-ink-3 hover:text-ink text-sm transition-colors shrink-0"
              >
                ✕
              </button>
            )}
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body
  );
}

/**
 * ConfirmDialog — the styled replacement for window.confirm on destructive
 * or irreversible actions. Always states what will happen; the confirm
 * button names the action, not "OK".
 */
interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  loading = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal open={open} onClose={onCancel} title={title} size="sm" dismissable={!loading}>
      {description && <div className="text-sm text-ink-2 leading-relaxed mb-5">{description}</div>}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" label={cancelLabel} onClick={onCancel} disabled={loading} />
        <Button
          variant={danger ? 'outline' : 'primary'}
          size="sm"
          label={loading ? 'Working…' : confirmLabel}
          onClick={onConfirm}
          disabled={loading}
          className={danger ? 'border-err text-err hover:bg-err/10' : undefined}
        />
      </div>
    </Modal>
  );
}
