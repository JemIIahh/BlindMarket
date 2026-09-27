import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import {
  Breadcrumb,
  PageHeader,
  Panel,
  Button,
  FormField,
  FormInput,
  FormTextarea,
  LoadingState,
  EmptyState,
  ErrorState,
  ErrorNotice,
} from '../components/bb';
import { authedGet, authedPost } from '../lib/api';
import { useSocket } from '../hooks/useSocket';

interface Message {
  id: number;
  task_id: string | null;
  from_address: string;
  to_address: string;
  subject: string | null;
  body: string;
  read_at: string | null;
  created_at: string;
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function timeAgo(iso: string): string {
  const d = new Date(iso);
  const delta = Date.now() - d.getTime();
  const mins = Math.floor(delta / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export default function Messages() {
  const qc = useQueryClient();
  // Authed routes — a signed-out visitor would 401 on both lists.
  const { isAuthenticated } = useAuth();
  const [searchParams] = useSearchParams();
  const selectedTaskId = searchParams.get('task') ?? undefined;
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState('');
  const [replySubject, setReplySubject] = useState('');
  const [selectedMsg, setSelectedMsg] = useState<Message | null>(null);
  const [replyTaskId, setReplyTaskId] = useState<string | undefined>(undefined);
  const [repliedIds, setRepliedIds] = useState<Set<number>>(new Set());
  const replyPanelRef = useRef<HTMLDivElement>(null);
  const selectedId = selectedMsg?.id;

  // Below lg the reply panel stacks under the whole list, so bring it into
  // view on selection — otherwise tapping a message looks like a no-op.
  useEffect(() => {
    if (selectedId == null || !window.matchMedia('(max-width: 1023px)').matches) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    replyPanelRef.current?.scrollIntoView({ block: 'start', behavior: reduceMotion ? 'auto' : 'smooth' });
  }, [selectedId]);

  useSocket('platform', { 'message:new': () => qc.invalidateQueries({ queryKey: ['messages'] }) });

  const {
    data: inboxData,
    isLoading,
    isError: inboxIsError,
    refetch: refetchInbox,
  } = useQuery({
    queryKey: ['messages', 'inbox', selectedTaskId],
    queryFn: () => authedGet<{ messages: Message[]; total: number; unread: number }>(
      `/api/v1/messages/inbox${selectedTaskId ? `?taskId=${selectedTaskId}` : ''}`,
    ),
    enabled: isAuthenticated,
  });

  const {
    data: sentData,
    isError: sentIsError,
    refetch: refetchSent,
  } = useQuery({
    queryKey: ['messages', 'sent', selectedTaskId],
    queryFn: () => authedGet<{ messages: Message[]; total: number }>(
      `/api/v1/messages/sent${selectedTaskId ? `?taskId=${selectedTaskId}` : ''}`,
    ),
    enabled: isAuthenticated,
  });

  const sendMutation = useMutation({
    mutationFn: (body: { to: string; taskId?: string; subject?: string; body: string }) =>
      authedPost('/api/v1/messages/send', body),
    onSuccess: () => {
      if (selectedMsg) setRepliedIds(prev => new Set(prev).add(selectedMsg.id));
      setReplyTo(null);
      setReplyBody('');
      setReplySubject('');
      setSelectedMsg(null);
      setReplyTaskId(undefined);
      qc.invalidateQueries({ queryKey: ['messages'] });
    },
  });

  const markReadMutation = useMutation({
    mutationFn: () => authedPost('/api/v1/messages/read', {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['messages'] }),
  });

  const messages = (inboxData?.messages ?? []).filter(m => !repliedIds.has(m.id));
  const sent = sentData?.messages ?? [];
  const unread = messages.filter(m => !m.read_at).length;

  const handleSend = () => {
    if (!replyTo || !replyBody.trim()) return;
    sendMutation.mutate({
      to: replyTo,
      taskId: replyTaskId || selectedTaskId,
      subject: replySubject || undefined,
      body: replyBody.trim(),
    });
  };

  return (
    <div>
      <Breadcrumb items={['account', 'messages']} />
      <PageHeader
        title="Messages."
        titleMuted="Talk with posters and agents."
      />

      {unread > 0 && (
        <div className="card-dark mb-6 px-5 py-3 text-sm text-ink flex items-center justify-between gap-3">
          <span className="flex items-center gap-2.5">
            <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" aria-hidden />
            {unread} unread message{unread !== 1 ? 's' : ''}
          </span>
          <Button
            variant="outline"
            size="sm"
            label="Mark all read"
            onClick={() => markReadMutation.mutate()}
          />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_480px] gap-6">
        {/* Message list */}
        <Panel padding="sm" className="sm:p-7">
          <div className="flex gap-4 mb-4 border-b border-line pb-3">
            <span className="text-[11px] font-mono font-semibold uppercase tracking-widest text-ink-3">
              inbox · {messages.length}
            </span>
            <span className="text-[11px] font-mono text-line-2" aria-hidden>|</span>
            <span className="text-[11px] font-mono text-ink-3">
              sent · {sent.length}
            </span>
          </div>

          {isLoading ? (
            <LoadingState label="Loading messages…" />
          ) : inboxIsError ? (
            <ErrorState
              title="Couldn't load messages"
              description="Something went wrong reaching your inbox. Check your connection and try again."
              onRetry={() => refetchInbox()}
            />
          ) : messages.length === 0 ? (
            <EmptyState
              title="No messages yet"
              description="Messages from task posters and the agents you work with appear here."
            />
          ) : (
            <div className="-mx-2 space-y-1">
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`rounded-xl px-4 py-4 cursor-pointer hover:bg-surface-2 transition-colors ${!msg.read_at ? 'bg-[color-mix(in_srgb,var(--bb-accent)_5%,transparent)]' : ''}`}
                  onClick={() => {
                    setSelectedMsg(msg);
                    setReplyTo(msg.from_address);
                    setReplySubject(msg.subject ? `Re: ${msg.subject}` : '');
                    setReplyTaskId(msg.task_id ?? undefined);
                    if (!msg.read_at) markReadMutation.mutate();
                  }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mb-1">
                        {!msg.read_at && <span className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" aria-label="unread" />}
                        <span className="text-xs font-mono text-ink-3">
                          from {shortAddr(msg.from_address)}
                        </span>
                        {msg.task_id && (
                          <span className="text-[10px] font-mono text-ink-3">
                            task #{msg.task_id.slice(0, 10)}…
                          </span>
                        )}
                      </div>
                      {msg.subject && (
                        <div className="text-sm font-semibold text-ink mb-1 break-words">{msg.subject}</div>
                      )}
                      <div className="text-xs text-ink-2 line-clamp-2">{msg.body}</div>
                    </div>
                    <span className="text-[10px] font-mono text-ink-3 flex-shrink-0">{timeAgo(msg.created_at)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {(sent.length > 0 || sentIsError) && (
            <div className="mt-6 border-t border-line pt-4">
              <div className="text-[11px] font-mono font-semibold uppercase tracking-widest text-ink-3 mb-3">
                sent messages
              </div>
              {sentIsError ? (
                <ErrorState
                  title="Couldn't load sent messages"
                  description="Something went wrong reaching your sent folder. Try again."
                  onRetry={() => refetchSent()}
                />
              ) : (
                <div className="-mx-2 space-y-1">
                  {sent.map((msg) => (
                    <div key={msg.id} className="rounded-xl px-4 py-3">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-mono text-ink-3">
                          to {shortAddr(msg.to_address)}
                        </span>
                        <span className="text-[10px] font-mono text-ink-3">{timeAgo(msg.created_at)}</span>
                      </div>
                      {msg.subject && (
                        <div className="text-xs text-ink-2 mb-0.5">{msg.subject}</div>
                      )}
                      <div className="text-xs text-ink-3 line-clamp-1">{msg.body}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </Panel>

        {/* Reply panel */}
        <div ref={replyPanelRef} className="space-y-4">
          <Panel padding="sm" className="sm:p-7">
            <div className="text-[11px] font-mono font-semibold uppercase tracking-widest text-ink-3 mb-4">
              {replyTo ? `reply to ${shortAddr(replyTo)}` : 'compose'}
            </div>

            {selectedMsg && (
              <div className="mb-5 pb-5 border-b border-line">
                {selectedMsg.subject && (
                  <div className="text-sm font-semibold text-ink mb-2">{selectedMsg.subject}</div>
                )}
                <div className="text-sm text-ink-2 leading-relaxed whitespace-pre-wrap break-words">{selectedMsg.body}</div>
                <div className="flex items-center gap-2 text-[10px] font-mono text-ink-3 mt-3">
                  <span>from {shortAddr(selectedMsg.from_address)}</span>
                  <span>·</span>
                  <span>{timeAgo(selectedMsg.created_at)}</span>
                </div>
              </div>
            )}

            {replyTo ? (
              <div className="space-y-3">
                <FormField label="Subject">
                  <FormInput
                    value={replySubject}
                    onChange={(e) => setReplySubject(e.target.value)}
                    placeholder="Optional"
                  />
                </FormField>
                <FormField label="Message" required>
                  <FormTextarea
                    value={replyBody}
                    onChange={(e) => setReplyBody(e.target.value)}
                    placeholder="Type your message…"
                    rows={8}
                  />
                </FormField>
                <div className="flex gap-2">
                  <Button
                    variant="primary"
                    label={sendMutation.isPending ? 'Sending…' : 'Send'}
                    onClick={handleSend}
                    disabled={!replyBody.trim() || sendMutation.isPending}
                  />
                  <Button
                    variant="ghost"
                    label="Cancel"
                    onClick={() => {
                      setReplyTo(null);
                      setReplyBody('');
                      setReplySubject('');
                      setSelectedMsg(null);
                      setReplyTaskId(undefined);
                    }}
                  />
                </div>
                {sendMutation.isError && <ErrorNotice error={sendMutation.error} title="Couldn't send the message" compact />}
              </div>
            ) : (
              <EmptyState
                icon="send"
                title="No message selected"
                description="Open a message to read it and reply."
              />
            )}
          </Panel>

          <div className="rounded-2xl border border-line bg-surface-2 p-5">
            <div className="text-[11px] font-mono font-semibold uppercase tracking-widest text-ink-3 mb-2">
              how messaging works
            </div>
            <p className="text-[13px] text-ink-3 leading-relaxed">
              Agents message you when they need more detail about a task, and your reply lands in their inbox.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
