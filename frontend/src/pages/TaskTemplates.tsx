import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAccount } from 'wagmi';
import {
  Breadcrumb,
  PageHeader,
  SectionRule,
  Button,
  Tag,
  FormField,
  FormInput,
  FormTextarea,
  Panel,
  LoadingState,
  EmptyState,
  ErrorState,
  ErrorNotice,
  Pagination,
  useTabParam,
  RadioPills,
  ButtonLink,
} from '../components/bb';
import {
  getPublicTemplates,
  createTemplate,
  getMyTemplates,
} from '../services/marketplace';
import { getPaymentSymbol, useSettlement } from '../config/settlement';
import { truncateAddress } from '../lib/utils';
import { useAuth } from '../context/AuthContext';

type Tab = 'browse' | 'mine' | 'create';

/** The route hard-caps `limit` at 50 (marketplace.ts), so a page cannot exceed it. */
const PAGE_SIZE = 24;

/** Post many (pages/PostMany.tsx) with this template picked. */
const postManyFrom = (id: number) => `/tasks/bulk?source=template&template=${id}`;

const TABS: { id: Tab; label: string }[] = [
  { id: 'browse', label: 'Public templates' },
  { id: 'mine', label: 'My templates' },
  { id: 'create', label: 'Create template' },
];

export default function TaskTemplates() {
  // Re-render when the backend's settlement answer arrives (config/settlement.ts).
  useSettlement();
  const [tab, setTab] = useTabParam<Tab>('browse', TABS.map((t) => t.id));
  const [page, setPage] = useState(1);
  const { address } = useAccount();
  // Auth, not the address, gates the authed read (the address arrives first).
  const { isAuthenticated } = useAuth();
  const paymentSymbol = getPaymentSymbol();
  const qc = useQueryClient();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [suggestedReward, setSuggestedReward] = useState('');
  const [isPublic, setIsPublic] = useState(true);

  const { data: publicData, isLoading: publicLoading, isError: publicError, refetch: refetchPublic } = useQuery({
    queryKey: ['public-templates', page],
    queryFn: () => getPublicTemplates(PAGE_SIZE, (page - 1) * PAGE_SIZE),
    enabled: tab === 'browse',
  });

  const { data: myTemplates, isLoading: myLoading, isError: myError, refetch: refetchMine } = useQuery({
    queryKey: ['my-templates', address],
    queryFn: () => getMyTemplates(),
    enabled: tab === 'mine' && isAuthenticated && !!address,
  });

  const createMut = useMutation({
    mutationFn: () => createTemplate({
      name,
      description,
      requiredCapabilities: [],
      suggestedReward: suggestedReward || undefined,
      isPublic,
    }),
    onSuccess: () => {
      setName('');
      setDescription('');
      setSuggestedReward('');
      setIsPublic(true);
      qc.invalidateQueries({ queryKey: ['public-templates'] });
      qc.invalidateQueries({ queryKey: ['my-templates'] });
      setTab('mine');
    },
  });

  return (
    <div>
      <Breadcrumb items={['marketplace', 'tasks', 'templates']} />
      <PageHeader
        title="Task templates."
        titleMuted="Start from a ready brief."
        right={<ButtonLink to="/tasks/bulk?source=template" variant="outline" label="Post many" />}
      />

      <div role="tablist" className="flex gap-5 sm:gap-7 border-b border-line mb-8 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`pb-3 -mb-px text-[14px] sm:text-[15px] border-b-2 transition-colors whitespace-nowrap shrink-0 ${
              tab === t.id
                ? 'text-ink font-medium border-ink'
                : 'text-ink-3 border-transparent hover:text-ink-2'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'browse' && (
        <div>
          {publicLoading ? (
            <div className="card-dark"><LoadingState label="Loading templates…" /></div>
          ) : publicError ? (
            <div className="card-dark"><ErrorState title="Couldn't load templates" onRetry={() => refetchPublic()} /></div>
          ) : !publicData?.templates.length ? (
            <div className="card-dark">
              <EmptyState
                icon="list"
                title="No public templates yet"
                description="Create one and share it with the marketplace."
                action={
                  <Button variant="outline" label="Create template" size="sm" onClick={() => setTab('create')} />
                }
              />
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {publicData.templates.map((t) => (
                <Panel key={t.id} padding="md">
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="min-w-0">
                      <div className="text-[17px] font-medium leading-snug tracking-[-0.02em] text-ink truncate">{t.name}</div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[11px] text-ink-3 font-mono">{t.use_count} uses</span>
                    </div>
                  </div>
                  <p className="text-[13.5px] text-ink-3 leading-relaxed line-clamp-3 mb-4">
                    {t.description}
                  </p>
                  <div className="flex items-center justify-between text-xs text-ink-3">
                    <span className="font-mono">{truncateAddress(t.creator_address)}</span>
                    {t.suggested_reward && <span className="font-mono text-ink-2">{t.suggested_reward} {paymentSymbol}</span>}
                  </div>
                  <div className="mt-4 pt-4 border-t border-line">
                    <ButtonLink to={postManyFrom(t.id)} variant="ghost" size="sm" label="Post many from this" />
                  </div>
                </Panel>
              ))}
            </div>
          )}

          {publicData && publicData.total > PAGE_SIZE && (
            <Pagination
              page={page}
              totalPages={Math.ceil(publicData.total / PAGE_SIZE)}
              totalItems={publicData.total}
              pageSize={PAGE_SIZE}
              onPageChange={setPage}
            />
          )}
        </div>
      )}

      {tab === 'mine' && (
        <div>
          {!address ? (
            <div className="card-dark">
              <EmptyState
                icon="wallet"
                title="Connect your wallet"
                description="Sign in to see the templates you've created."
              />
            </div>
          ) : myLoading ? (
            <div className="card-dark"><LoadingState label="Loading your templates…" /></div>
          ) : myError ? (
            <div className="card-dark"><ErrorState title="Couldn't load your templates" onRetry={() => refetchMine()} /></div>
          ) : !myTemplates?.length ? (
            <div className="card-dark">
              <EmptyState
                icon="list"
                title="No templates yet"
                description="Templates you create will appear here."
                action={
                  <Button variant="outline" label="Create template" size="sm" onClick={() => setTab('create')} />
                }
              />
            </div>
          ) : (
            <div className="space-y-3">
              {myTemplates.map((t) => (
                <div key={t.id} className="card-dark flex items-center justify-between gap-3 px-5 py-4 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="text-ink font-medium truncate">{t.name}</div>
                    <div className="text-xs text-ink-3 mt-0.5">
                      {t.use_count} uses{t.suggested_reward && ` · ${t.suggested_reward} ${paymentSymbol}`}
                    </div>
                  </div>
                  <Tag tone={t.is_public ? 'ok' : 'neutral'}>{t.is_public ? 'public' : 'private'}</Tag>
                  <ButtonLink to={postManyFrom(t.id)} variant="ghost" size="sm" label="Post many" className="shrink-0" />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'create' && (
        <div className="card-dark max-w-2xl space-y-5 p-7">
          <SectionRule num="01" title="New template" />
          <FormField label="Template name" required>
            <FormInput placeholder="e.g. Market research report" value={name} onChange={(e) => setName(e.target.value)} />
          </FormField>
          <FormField label="Description" required hint="Describe the task brief in detail">
            <FormTextarea rows={6} placeholder="Describe what needs to be done…" value={description} onChange={(e) => setDescription(e.target.value)} />
          </FormField>
          <div className="grid grid-cols-2 gap-4">
            <FormField label={`Suggested reward (${paymentSymbol})`}>
              <FormInput className="font-mono" placeholder="50" value={suggestedReward} onChange={(e) => setSuggestedReward(e.target.value)} />
            </FormField>
            <FormField label="Visibility">
              <RadioPills
                label="Visibility"
                value={isPublic ? 'public' : 'private'}
                options={[['public', 'Public'], ['private', 'Private']] as const}
                onChange={(option) => setIsPublic(option === 'public')}
              />
            </FormField>
          </div>
          <div className="flex items-center gap-3 pt-2">
            <Button
              variant="primary"
              label={createMut.isPending ? 'Creating…' : 'Create template'}
              disabled={!name.trim() || !description.trim() || createMut.isPending}
              onClick={() => createMut.mutate()}
            />
            {createMut.isError && <ErrorNotice error={createMut.error} title="Couldn't create the template" compact />}
          </div>
        </div>
      )}
    </div>
  );
}
