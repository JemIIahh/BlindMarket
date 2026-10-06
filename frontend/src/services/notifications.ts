import { authedGet, authedPost } from '../lib/api';

export type NotificationType =
  | 'assigned'
  | 'submitted'
  | 'completed'
  | 'failed'
  | 'disputed'
  | 'review_received'
  /** A task's deadline passed with its escrow still held: the poster can reclaim it. */
  | 'expired'
  /** A task's deadline is close and it is still waiting on an agent, its work or a verdict. */
  | 'deadline_soon'
  /** A hosted agent was left stopped (not restarted with the server): its owner can start it again. */
  | 'agent_stopped';

export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  body?: string;
  taskId?: string;
  createdAt: string;
  read: boolean;
}

export async function listNotifications(
  limit = 30,
  offset = 0,
): Promise<{ notifications: Notification[]; total: number; unread: number }> {
  return authedGet<{ notifications: Notification[]; total: number; unread: number }>(
    `/api/v1/notifications?limit=${limit}&offset=${offset}`,
  );
}

export async function unreadCount(): Promise<number> {
  const d = await authedGet<{ unread: number }>('/api/v1/notifications/unread-count');
  return d.unread ?? 0;
}

export async function markRead(id: string): Promise<void> {
  await authedPost(`/api/v1/notifications/${id}/read`, {});
}

export async function markAllRead(): Promise<void> {
  await authedPost('/api/v1/notifications/read-all', {});
}
