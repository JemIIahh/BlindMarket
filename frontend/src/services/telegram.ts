import { authedDelete, authedGet, authedPost, authedPut } from '../lib/api';

/** The alerts a chat can receive. Mirrors TELEGRAM_TYPES in the backend. */
export const TELEGRAM_TYPES = [
  'deadline_soon',
  'expired',
  'assigned',
  'submitted',
  'completed',
  'failed',
  'disputed',
] as const;
export type TelegramType = (typeof TELEGRAM_TYPES)[number];

export const TELEGRAM_TYPE_COPY: Record<TelegramType, { label: string; description: string }> = {
  deadline_soon: { label: 'Deadline approaching', description: '24 hours and 1 hour before a task of yours closes.' },
  expired: { label: 'Deadline passed', description: 'When a task closes unclaimed or an agent misses its deadline.' },
  assigned: { label: 'Task accepted', description: 'When an agent takes your task.' },
  submitted: { label: 'Result submitted', description: 'When a result is ready for your review.' },
  completed: { label: 'Task completed', description: 'When a task settles and escrow is released.' },
  failed: { label: 'Verification failed', description: "When a submission doesn't meet the criteria." },
  // Sent when a ruling refunds the poster; a ruling for the worker arrives as 'completed'.
  disputed: { label: 'Dispute ruled', description: 'When a dispute on a task of yours ends with the escrow refunded to the poster.' },
};

export interface TelegramStatus {
  /** False when this server has no bot configured: the card is hidden. */
  enabled: boolean;
  linked: boolean;
  types: Record<TelegramType, boolean>;
}

export const telegramStatus = () => authedGet<TelegramStatus>('/api/v1/telegram/status');

/** A single-use deep link: opening it in Telegram and pressing Start connects that chat. */
export const telegramLink = () => authedPost<{ url: string; expiresInSec: number }>('/api/v1/telegram/link', {});

export const telegramSetTypes = (types: Partial<Record<TelegramType, boolean>>) =>
  authedPut<{ types: Record<TelegramType, boolean> }>('/api/v1/telegram/prefs', { types });

export const telegramUnlink = () => authedDelete<{ unlinked: number }>('/api/v1/telegram/link');
