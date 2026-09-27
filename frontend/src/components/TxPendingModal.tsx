import { Modal } from './bb';
import { Spinner } from './bb/states';

interface TxPendingModalProps {
  open: boolean;
  message?: string;
}

/** Blocking overlay while a transaction awaits the user's wallet — not
 * dismissable by design; it clears itself when the tx resolves. */
export function TxPendingModal({ open, message = 'Confirm in your wallet' }: TxPendingModalProps) {
  return (
    <Modal open={open} onClose={() => {}} dismissable={false} size="sm">
      <div className="text-center py-4">
        <div className="mx-auto w-14 h-14 rounded-full border border-line bg-surface-2 flex items-center justify-center mb-4">
          <svg className="w-7 h-7 text-warn" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
        </div>
        <h3 className="text-base font-semibold text-ink mb-2">Transaction pending</h3>
        <p className="text-sm text-ink-3">{message}</p>
        <div className="mt-4 flex justify-center">
          <Spinner size={22} />
        </div>
      </div>
    </Modal>
  );
}
