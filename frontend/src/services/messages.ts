import { authedGet } from '../lib/api';

/**
 * The sidebar's Messages badge. GET /api/v1/messages/unread-count answers
 * `{ unread }` (backend/src/routes/messages.ts); the badge once read `count`,
 * so it never showed.
 */
export async function unreadMessageCount(): Promise<number> {
  const d = await authedGet<{ unread: number }>('/api/v1/messages/unread-count');
  return d.unread ?? 0;
}
