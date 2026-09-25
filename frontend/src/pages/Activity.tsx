import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import {
  Breadcrumb,
  PageHeader,
  Button,
  Icon,
  LoadingState,
  EmptyState,
  ErrorState,
  Pagination,
} from '../components/bb';
import { useAuth } from '../context/AuthContext';
import { useNotificationList } from '../hooks/useNotifications';
import { markAllRead, markRead, type Notification, type NotificationType } from '../services/notifications';

const PAGE_SIZE = 20;

const TYPE_ICON: Record<NotificationType, string> = {
  assigned: 'bolt',
  submitted: 'send',
  completed: 'check',
  failed: 'alert',
  disputed: 'shield',
  review_received: 'user',
  expired: 'clock',
  agent_stopped: 'alert',
};

function ago(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const mins = Math.floor((Date.now() - t) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(t).toLocaleDateString();
}

export default function Activity() {
  const { isAuthenticated } = useAuth();
  const [page, setPage] = useState(1);
  const { data, isLoading, isError, refetch, invalidate } = useNotificationList(page, PAGE_SIZE);

  const readAll = useMutation({
    mutationFn: () => markAllRead(),
    onSuccess: () => invalidate(),
  });

  async function openNotif(n: Notification) {
    if (!n.read) {
      try {
        await markRead(n.id);
      } catch {
        /* non-blocking — the task page matters more than the badge */
      }
      invalidate();
    }
  }

  const notifications = data?.notifications ?? [];
  const total = data?.total ?? 0;
  const unread = data?.unread ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <Breadcrumb items={['account', 'activity']} />
      <PageHeader
        title="Activity"
        description="Your event diary — assignments, submissions, completions, reviews, and disputes."
        right={
          unread > 0 ? (
            <Button
              variant="outline"
              size="sm"
              label={readAll.isPending ? 'Marking…' : 'Mark all read'}
              onClick={() => readAll.mutate()}
              disabled={readAll.isPending}
            />
          ) : undefined
        }
      />

      {!isAuthenticated ? (
        <EmptyState
          icon="bell"
          title="Connect your wallet"
          description="Connect a wallet to see the events on your tasks."
        />
      ) : isLoading ? (
        <LoadingState label="Loading activity…" />
      ) : isError ? (
        <ErrorState title="Couldn't load activity" onRetry={() => refetch()} />
      ) : notifications.length === 0 ? (
        <EmptyState
          icon="bell"
          title="No activity yet"
          description="When an agent accepts your task, submits work, or you get paid, it lands here."
        />
      ) : (
        <div className="border border-line divide-y divide-line">
          {notifications.map((n) => {
            const inner = (
              <div className="flex items-start gap-3 p-4 hover:bg-surface-2/60 transition-colors">
                <span className={`mt-0.5 shrink-0 ${n.read ? 'text-ink-3' : 'text-cream'}`}>
                  <Icon name={TYPE_ICON[n.type] ?? 'bell'} size={17} />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-sm ${n.read ? 'text-ink-2' : 'text-ink font-medium'}`}>
                      {n.title}
                    </span>
                    {!n.read && <span className="w-1.5 h-1.5 bg-cream shrink-0" aria-label="unread" />}
                  </div>
                  {n.body && (
                    <p className="text-xs text-ink-3 mt-0.5 leading-relaxed">{n.body}</p>
                  )}
                  <p className="text-[11px] text-ink-3 font-mono mt-1">{ago(n.createdAt)}</p>
                </div>
                {n.taskId && (
                  <span className="text-[11px] text-ink-3 shrink-0 group-hover:text-cream">View →</span>
                )}
              </div>
            );
            return n.taskId ? (
              <Link key={n.id} to={`/tasks/${n.taskId}`} onClick={() => openNotif(n)} className="block group">
                {inner}
              </Link>
            ) : (
              <div key={n.id}>{inner}</div>
            );
          })}
        </div>
      )}
      {total > 0 && (
        <Pagination
          page={page}
          totalPages={totalPages}
          totalItems={total}
          pageSize={PAGE_SIZE}
          onPageChange={setPage}
        />
      )}
    </div>
  );
}
