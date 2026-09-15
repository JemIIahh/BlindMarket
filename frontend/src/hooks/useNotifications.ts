import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { listNotifications, unreadCount } from '../services/notifications';

/**
 * Header-bell unread count. Same 30s poll pattern as the messages badge —
 * notifications are server-persisted (Redis), so polling is the freshness
 * mechanism; no socket auth exists for browser clients.
 */
export function useUnreadNotifications() {
  const { isAuthenticated } = useAuth();
  return useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: () => unreadCount(),
    enabled: isAuthenticated,
    refetchInterval: 30_000,
  });
}

export function useNotificationList(page: number, pageSize: number) {
  const { isAuthenticated } = useAuth();
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['notifications', 'list', page],
    queryFn: () => listNotifications(pageSize, (page - 1) * pageSize),
    enabled: isAuthenticated,
  });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['notifications'] });
  };
  return { ...query, invalidate };
}
