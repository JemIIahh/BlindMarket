import { useState, useEffect, useCallback } from 'react';
import { Button, FormField, FormInput, LoadingState, EmptyState, ErrorState, ErrorNotice } from '../bb';
import {
  getWebhooks,
  registerWebhook as apiRegisterWebhook,
  deleteWebhook,
} from '../../services/marketplace';
import type { AgentWebhook } from '../../services/marketplace';

export function WebhooksPanel({ agentId: _agentId }: { agentId: string }) {
  const [hooks, setHooks] = useState<AgentWebhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown>('');

  const loadHooks = useCallback(() => {
    setLoading(true);
    setError(false);
    getWebhooks()
      .then(setHooks)
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    getWebhooks()
      .then(h => { if (!cancelled) setHooks(h); })
      .catch(() => { if (!cancelled) setError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  async function handleCreate() {
    if (!url) return;
    setCreating(true);
    setCreateError('');
    try {
      await apiRegisterWebhook({
        url,
        secret: secret.trim() || undefined,
      });
      setUrl('');
      setSecret('');
      await loadHooks();
    } catch (err) {
      setCreateError(err);
    } finally {
      setCreating(false);
    }
  }

  if (loading) return <LoadingState label="Loading webhooks…" />;
  if (error) return <ErrorState title="Couldn't load webhooks" onRetry={() => loadHooks()} />;

  return (
    <div className="space-y-5">
      {/* Existing webhooks */}
      {hooks.length === 0 ? (
        <EmptyState
          icon="settings"
          title="No webhooks configured"
          description="Receive real-time notifications when this agent gets tasks assigned."
        />
      ) : (
        <div className="space-y-2">
          {hooks.map((h) => (
            <div key={h.id} className="card-dark flex items-center justify-between gap-3 px-5 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <div className="text-ink font-mono text-xs break-all truncate">{h.url}</div>
                <div className="text-[11px] text-ink-3 mt-0.5">{h.events.join(', ')}</div>
              </div>
              <button
                onClick={async () => {
                  try {
                    await deleteWebhook(h.id);
                    await loadHooks();
                  } catch (err) {
                    // Surface instead of silently rejecting — the row staying
                    // put with no feedback reads as a dead button.
                    setCreateError(err);
                  }
                }}
                className="-mx-2 px-2 py-1.5 min-h-[32px] text-xs text-err hover:underline shrink-0"
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Register new webhook */}
      <div className="card-dark p-5 sm:p-6">
        <div className="text-sm font-medium text-ink mb-3">Register webhook</div>
        <FormField label="URL" required>
          <FormInput className="font-mono" placeholder="https://your-service.com/webhook" value={url} onChange={(e) => setUrl(e.target.value)} />
        </FormField>
        <FormField label="Secret" hint="HMAC-SHA256 signing secret (auto-generated if empty)">
          <FormInput className="font-mono" placeholder="Leave empty for auto-generate" value={secret} onChange={(e) => setSecret(e.target.value)} />
        </FormField>
        <div className="flex flex-wrap items-center gap-3 mt-3">
          <Button
            variant="primary"
            size="sm"
            label={creating ? 'Registering…' : 'Register webhook'}
            disabled={!url || creating}
            onClick={handleCreate}
          />
          <ErrorNotice error={createError} title="Couldn't update webhooks" compact />
        </div>
      </div>
    </div>
  );
}
