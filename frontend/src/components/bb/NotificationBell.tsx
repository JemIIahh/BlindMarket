import { Link } from 'react-router-dom';
import { Icon } from './Icon';
import { useUnreadNotifications } from '../../hooks/useNotifications';

/** Header bell — badge mirrors the sidebar messages pattern. */
export function NotificationBell() {
  const { data } = useUnreadNotifications();
  const unread = data ?? 0;
  return (
    <Link
      to="/activity"
      aria-label={unread > 0 ? `${unread} unread notifications` : 'Activity'}
      title="Activity"
      className="relative p-2 text-ink-2 hover:text-ink transition-colors"
    >
      <Icon name="bell" size={19} />
      {unread > 0 && (
        <span className="absolute top-0.5 right-0.5 min-w-[16px] h-[16px] flex items-center justify-center rounded-full bg-cream text-bg text-[9px] font-semibold leading-none px-1">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </Link>
  );
}
