import { useState, useEffect, useCallback, useRef } from 'react';
import { parseEther, formatUnits } from 'ethers';
import {
  SectionRule,
  Tag,
  Button,
  Icon,
  FormField,
  FormInput,
  FormTextarea,
  FormSelect,
  LoadingState,
  ErrorState,
} from '../bb';
import {
  getAgentServices,
  createService,
  updateService,
  deleteService,
} from '../../services/marketplace';
import type { AgentService } from '../../services/marketplace';
import UseServiceModal from '../UseServiceModal';
import UseFromAgentModal from '../UseFromAgentModal';

/**
 * The storefront. The public list is owned by the page (the header from-price
 * and the sold stat read the same rows); this section owns only the owner's
 * manage list and the rent modals.
 */
export function ServicesSection({
  agentId,
  isOwner,
  symbol,
  agentStatus,
  services,
  loading,
  loadError,
  onReload,
  onLinkOwner,
}: {
  agentId: string;
  isOwner: boolean;
  symbol: string;
  agentStatus: string;
  services: AgentService[] | null;
  loading: boolean;
  loadError: boolean;
  onReload: () => Promise<void>;
  onLinkOwner: () => Promise<void>;
}) {
  const [useService, setUseService] = useState<AgentService | null>(null);
  const [agentUseService, setAgentUseService] = useState<AgentService | null>(null);
  const [needsLink, setNeedsLink] = useState(false);
  const [linking, setLinking] = useState(false);
  const retryRef = useRef<null | (() => Promise<void>)>(null);
  const [ownerServices, setOwnerServices] = useState<AgentService[] | null>(null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [serviceType, setServiceType] = useState<'api' | 'a2a'>('api');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [showDesc, setShowDesc] = useState(false);

  const loadOwnerServices = useCallback(async () => {
    if (!isOwner) { setOwnerServices(null); return; }
    try { setOwnerServices(await getAgentServices(agentId)); } catch { /* owner list is additive */ }
  }, [isOwner, agentId]);

  useEffect(() => { loadOwnerServices(); }, [loadOwnerServices]);

  const load = useCallback(async () => {
    await Promise.all([onReload(), loadOwnerServices()]);
  }, [onReload, loadOwnerServices]);

  const fmt = (wei: string) => {
    try { return `${formatUnits(wei, 18)} ${symbol}`; } catch { return `${wei} wei`; }
  };

  function onMutationError(err: unknown, retry: () => Promise<void>) {
    if ((err as { code?: string }).code === 'FORBIDDEN') {
      setNeedsLink(true);
      retryRef.current = retry;
      setFormError("This wallet isn't linked to the agent yet — link it and retry.");
    } else {
      setFormError((err as Error).message);
    }
  }

  async function linkAndRetry() {
    setLinking(true);
    setFormError('');
    try {
      await onLinkOwner();
      setNeedsLink(false);
      const retry = retryRef.current;
      retryRef.current = null;
      if (retry) await retry();
    } catch (err) {
      setFormError((err as Error).message || 'Could not link this wallet');
    } finally {
      setLinking(false);
    }
  }

  async function handleCreate() {
    setFormError('');
    if (name.trim().length < 5) { setFormError('Name must be at least 5 characters.'); return; }
    let priceRaw: string;
    try { priceRaw = parseEther(price || '0').toString(); } catch { setFormError('Enter a valid price.'); return; }
    if (priceRaw === '0') { setFormError('Price must be greater than 0.'); return; }
    setSaving(true);
    try {
      await createService(agentId, { name: name.trim(), description: description.trim(), priceRaw, serviceType });
      setName(''); setDescription(''); setPrice(''); setServiceType('api');
      setNeedsLink(false);
      setShowDesc(false);
      await load();
    } catch (err) {
      onMutationError(err, handleCreate);
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(s: AgentService) {
    try { await updateService(agentId, s.id, { active: !s.active }); await load(); }
    catch (err) { onMutationError(err, () => toggleActive(s)); }
  }
  async function remove(s: AgentService) {
    try { await deleteService(agentId, s.id); await load(); }
    catch (err) { onMutationError(err, () => remove(s)); }
  }

  const scrollToForm = () => {
    document.getElementById('owner-services-form')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return (
    <section id="services" className="scroll-mt-6">
      <div className="flex items-center gap-3 mb-5">
        <SectionRule num="01" title="Services" side={services?.length ? `${services.length} listed` : undefined} className="flex-1 mb-0" />
        {isOwner && (
          <Button variant="outline" size="sm" label="Add service" onClick={scrollToForm} />
        )}
      </div>

      {loading ? (
        <LoadingState label="Loading services…" />
      ) : loadError ? (
        <ErrorState title="Couldn't load services" onRetry={() => onReload()} />
      ) : (
        <>
          {agentStatus !== 'running' && services && services.length > 0 && (
            <div className="mb-3 text-xs text-ink-3 border border-line bg-surface-2 px-3 py-2">
              This agent is stopped — the owner must start it before it can take calls.
            </div>
          )}
          {services && services.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {services.map(s => (
                <div key={s.id} className="border border-line bg-surface-2 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-ink font-medium">{s.name}</div>
                    <Tag tone="info">{s.service_type}</Tag>
                  </div>
                  {s.description && <div className="text-xs text-ink-3 mt-1.5">{s.description}</div>}
                  <div className="flex flex-wrap items-center justify-between gap-3 mt-4 pt-3 border-t border-line">
                    <div className="min-w-0">
                      <span className="whitespace-nowrap">
                        <span className="font-mono text-cream text-sm">{fmt(s.price_raw)}</span>
                        <span className="font-mono text-ink-3 text-xs"> / call</span>
                      </span>
                      {s.sold_count > 0 && (
                        <div className="whitespace-nowrap font-mono text-[11px] text-ink-3 mt-0.5">{s.sold_count} sold{s.avg_rating > 0 ? ` · ★ ${s.avg_rating.toFixed(1)}` : ''}</div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Button
                        variant="ghost"
                        size="sm"
                        label="Use from your agent"
                        disabled={!s.agent_public_key}
                        onClick={() => setAgentUseService(s)}
                      />
                      <Button
                        variant="primary"
                        size="sm"
                        label="Use now"
                        disabled={agentStatus !== 'running' || !s.agent_public_key}
                        onClick={() => setUseService(s)}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="border border-dashed border-line bg-surface-2 px-5 py-6 text-center">
              <div className="flex justify-center mb-2">
                <Icon name="briefcase" size={20} className="text-ink-3" />
              </div>
              <div className="text-sm text-ink font-medium">
                {isOwner ? 'No services yet' : 'No rentable services'}
              </div>
              <div className="text-xs text-ink-3 mt-1">
                {isOwner
                  ? 'Publish a service to let others call this agent.'
                  : 'This agent has no rentable services yet.'}
              </div>
            </div>
          )}
        </>
      )}

      {isOwner && (
        <div className="mt-8 pt-6 border-t border-line" id="owner-services-form">
          {ownerServices && ownerServices.length > 0 && (
            <div className="mb-4 space-y-2">
              {ownerServices.map(s => (
                <div key={s.id} className="flex items-center justify-between gap-3 border border-line bg-surface-2 px-4 py-2.5">
                  <div className="min-w-0">
                    <div className="text-ink text-sm truncate">
                      {s.name}{!s.active && <span className="text-ink-3 text-xs"> · inactive</span>}
                    </div>
                    <div className="font-mono text-xs text-ink-3">{fmt(s.price_raw)} / call · {s.service_type}</div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button variant="ghost" size="sm" label={s.active ? 'Deactivate' : 'Activate'} onClick={() => toggleActive(s)} />
                    <Button variant="ghost" size="sm" label="Delete" onClick={() => remove(s)} />
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="border border-line bg-surface-2 p-4 space-y-3">
            <div className="flex flex-col sm:flex-row gap-3">
              <FormField label="Service name" required className="flex-[2] min-w-0">
                <FormInput placeholder="e.g. Market sentiment analysis" value={name} onChange={e => setName(e.target.value)} />
              </FormField>
              <FormField label={`Price (${symbol})`} required className="flex-1 min-w-0">
                <FormInput className="font-mono" placeholder="0.5" value={price} onChange={e => setPrice(e.target.value)} />
              </FormField>
              <FormField label="Type" className="flex-1 min-w-0">
                <FormSelect value={serviceType} onChange={e => setServiceType(e.target.value as 'api' | 'a2a')}>
                  <option value="api">API</option>
                  <option value="a2a">A2A</option>
                </FormSelect>
              </FormField>
              <div className="flex items-end">
                <Button
                  variant="primary"
                  size="sm"
                  label={saving ? 'Publishing…' : 'Publish'}
                  disabled={saving}
                  onClick={handleCreate}
                  className="w-full sm:w-auto"
                />
              </div>
            </div>

            {showDesc ? (
              <div className="flex items-start gap-2">
                <FormField label="Description" className="flex-1">
                  <FormTextarea rows={2} placeholder="What the buyer gets per call" value={description} onChange={e => setDescription(e.target.value)} />
                </FormField>
                <button
                  type="button"
                  onClick={() => { setShowDesc(false); setDescription(''); }}
                  className="mt-6 text-ink-3 hover:text-ink transition-colors shrink-0"
                  aria-label="Remove description"
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowDesc(true)}
                className="text-xs text-ink-3 hover:text-ink transition-colors flex items-center gap-1"
              >
                <Icon name="plus" size={12} />
                Add description
              </button>
            )}

            {formError && <div className="text-xs text-err">{formError}</div>}
            {needsLink && (
              <Button variant="outline" size="sm" label={linking ? 'Linking…' : 'Link this wallet & retry'} disabled={linking} onClick={linkAndRetry} />
            )}
          </div>
        </div>
      )}

      {useService && (
        <UseServiceModal
          service={useService}
          symbol={symbol}
          onClose={() => setUseService(null)}
          onSettled={load}
        />
      )}
      {agentUseService && (
        <UseFromAgentModal
          service={agentUseService}
          symbol={symbol}
          onClose={() => setAgentUseService(null)}
        />
      )}
    </section>
  );
}
