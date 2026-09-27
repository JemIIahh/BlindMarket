import { Link } from 'react-router-dom';
import { iconButtonClass } from './Button';
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
      className={iconButtonClass('outline')}
    >
      <Icon name="bell" size={17} />
      {unread > 0 && (
        <span className="absolute -top-1 -right-1 min-w-[16px] h-[16px] flex items-center justify-center rounded-full bg-accent text-accent-ink text-[9px] font-semibold leading-none px-1">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </Link>
  );
}
