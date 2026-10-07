import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../context/AuthContext';
import { Button, ErrorNotice, Toggle } from '../bb';
import {
  TELEGRAM_TYPES,
  TELEGRAM_TYPE_COPY,
  telegramLink,
  telegramSetTypes,
  telegramStatus,
  telegramUnlink,
  type TelegramType,
} from '../../services/telegram';

const LIST_BOX = 'overflow-hidden rounded-2xl border border-line divide-y divide-line';
const KEY = ['telegram', 'status'] as const;

/**
 * Telegram alerts for the signed-in wallet. Opt-in and removable: nothing is
 * linked until the user presses Start in the bot, and Disconnect (or /stop in
 * Telegram) removes it. Hidden when the server has no bot configured.
 */
export function TelegramAlerts() {
  const { isAuthenticated } = useAuth();
  const qc = useQueryClient();
  // The link just minted, until the chat presses Start or the link expires.
  // While set, poll so the card switches to the toggles on its own.
  const [pending, setPending] = useState<{ url: string; until: number } | null>(null);

  const status = useQuery({
    queryKey: KEY,
    queryFn: telegramStatus,
    enabled: isAuthenticated,
    refetchInterval: (q) => (pending && !q.state.data?.linked && Date.now() < pending.until ? 3_000 : false),
  });

  const connect = useMutation({
    mutationFn: telegramLink,
    onSuccess: ({ url, expiresInSec }) => {
      setPending({ url, until: Date.now() + expiresInSec * 1000 });
      // Browsers that block a window opened after a request (Safari) still
      // get the visible link below.
      window.open(url, '_blank', 'noopener,noreferrer');
    },
  });
  const setType = useMutation({
    mutationFn: ({ type, on }: { type: TelegramType; on: boolean }) => telegramSetTypes({ [type]: on }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
  const disconnect = useMutation({
    mutationFn: telegramUnlink,
    onSuccess: () => {
      setPending(null);
      qc.invalidateQueries({ queryKey: KEY });
    },
  });

  const linkedNow = status.data?.linked === true;
  // Stop waiting once the chat is connected, or when the link expires.
  useEffect(() => {
    if (!pending) return;
    if (linkedNow) {
      setPending(null);
      return;
    }
    const t = setTimeout(() => setPending(null), Math.max(0, pending.until - Date.now()));
    return () => clearTimeout(t);
  }, [pending, linkedNow]);

  const data = status.data;
  if (!isAuthenticated || !data?.enabled) return null;
  const linked = data.linked;
  const showWaiting = pending !== null && !linked;

  return (
    <div className="space-y-4 pt-5 border-t border-line">
      <div>
        <div className="text-sm text-ink">Telegram alerts</div>
        <div className="text-xs text-ink-3 mt-0.5 leading-relaxed">
          Get task deadlines and status in Telegram. Alerts carry only a status, a deadline and a short task id,
          never your brief or results. Disconnect at any time.
        </div>
      </div>

      {!linked ? (
        <div className="space-y-3">
          <Button
            variant="outline"
            size="sm"
            label={connect.isPending ? 'Opening…' : showWaiting ? 'New link' : 'Connect Telegram'}
            disabled={connect.isPending}
            onClick={() => connect.mutate()}
          />
          {showWaiting && pending && (
            <div className="text-xs text-ink-3 leading-relaxed">
              <a href={pending.url} target="_blank" rel="noopener noreferrer" className="text-ink underline">
                Open Telegram
              </a>{' '}
              and press <span className="text-ink-2">Start</span>. This page connects on its own once you do. The link works for 10 minutes.
            </div>
          )}
          {connect.error && <ErrorNotice error={connect.error} title="Couldn't start Telegram connect" />}
        </div>
      ) : (
        <div className="space-y-4">
          <div className={LIST_BOX}>
            {/* Only the types this server offers: it leaves out the ones whose feature is off. */}
            {TELEGRAM_TYPES.filter((type) => type in data.types).map((type) => (
              <div key={type} className="flex items-center justify-between gap-4 px-4 py-3.5">
                <div className="min-w-0">
                  <div className="text-sm text-ink">{TELEGRAM_TYPE_COPY[type].label}</div>
                  <div className="text-xs text-ink-3 mt-0.5 leading-relaxed">{TELEGRAM_TYPE_COPY[type].description}</div>
                </div>
                <Toggle
                  checked={data.types[type] !== false}
                  onChange={(on) => setType.mutate({ type, on })}
                  disabled={setType.isPending}
                  label={TELEGRAM_TYPE_COPY[type].label}
                />
              </div>
            ))}
          </div>
          {setType.error && <ErrorNotice error={setType.error} title="Couldn't save that setting" />}
          <Button
            variant="ghost"
            size="sm"
            label={disconnect.isPending ? 'Disconnecting…' : 'Disconnect Telegram'}
            disabled={disconnect.isPending}
            onClick={() => disconnect.mutate()}
          />
          {disconnect.error && <ErrorNotice error={disconnect.error} title="Couldn't disconnect" />}
        </div>
      )}
    </div>
  );
}
