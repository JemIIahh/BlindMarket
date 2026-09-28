import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useWalletClient } from 'wagmi';
import { useSendTransaction } from '@privy-io/react-auth';
import { BrowserProvider, formatUnits } from 'ethers';
import {
  Breadcrumb,
  Button,
  ButtonLink,
  ConfirmDialog,
  ErrorNotice,
  FormField,
  FormSelect,
  FormTextarea,
  Icon,
  PageHeader,
  RadioPills,
  SectionRule,
  SignInGate,
  Spinner,
  Tag,
} from '../components/bb';
import { useAuth } from '../context/AuthContext';
import { useWallet } from '../context/WalletContext';
import { useChain } from '../context/ChainContext';
import { useAccountWallets, useChainAddress } from '../hooks/useChainWallet';
import { unlinkedSignerError } from '../lib/accountWallet';
import { authedPost } from '../lib/api';
import { friendlyErrorText } from '../lib/friendlyError';
import { clearPendingIndex, listPendingIndex, savePendingIndex } from '../lib/pendingIndex';
import {
  fetchWrapTargets,
  postingToken,
  postWithRetry,
  prepareBrief,
  retryPendingListing,
  sealToKeyCustody,
  uploadBrief,
  uploadBriefs,
  wrapKeyToExecutors,
  type BatchIndexResult,
} from '../lib/postTaskFlow';
import {
  EXAMPLE_CSV,
  KNOWN_COLUMNS,
  applyTemplate,
  briefTitle,
  bulkTotals,
  checkRows,
  parseBulkText,
  plannedTransactions,
  resultsCsv,
  templateVariables,
  type CheckedRows,
  type RowIssue,
} from '../lib/bulkRows';
import { DEFAULT_CHUNK, runBulkPost, type BulkDeps, type BulkState, type RowStatus } from '../lib/bulkPost';
import { pinnedContracts } from '../lib/bulkCalls';
import { clearRun, isSendable, loadRun, mayRequeue, saveRun, settleInFlight, type StoredStatus } from '../lib/bulkRunStore';
import { bulkSigner, ensureTotalAllowance, type PrivySend } from '../lib/bulkWallet';
import { isDirectSigned, providerFor } from '../lib/txSigner';
import { WORKER_SHARE_PCT, PLATFORM_FEE_PCT } from '../config/constants';
import {
  batchSupport,
  explorerUrlFor,
  getMarketplaceTokenAddress,
  getPaymentDecimals,
  getPaymentSymbol,
  getPostingEscrowAddress,
  useSettlement,
} from '../config/settlement';
import { getMyTemplates, getPublicTemplates, type TaskTemplate } from '../services/marketplace';
import type { UnsignedTx } from '../types/api';

type Source = 'file' | 'paste' | 'template';

const STATE_VIEW: Record<BulkState, { text: string; tone: 'ok' | 'warn' | 'err' | 'info' | 'neutral'; busy?: boolean }> = {
  queued: { text: 'Queued', tone: 'neutral' },
  preparing: { text: 'Preparing', tone: 'info', busy: true },
  funding: { text: 'Paying', tone: 'info', busy: true },
  sending: { text: 'Paying', tone: 'info', busy: true },
  listing: { text: 'Listing', tone: 'info', busy: true },
  done: { text: 'Posted', tone: 'ok' },
  unlisted: { text: 'Paid, not listed', tone: 'warn' },
  failed: { text: 'Not posted', tone: 'err' },
  unknown: { text: 'Check My tasks', tone: 'warn' },
};

function shortDuration(secs: number): string {
  return secs < 86_400 ? `${Math.round(secs / 3600)}h` : `${Math.round(secs / 86_400)}d`;
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function PostMany() {
  const { postingChain } = useSettlement();
  const decimals = getPaymentDecimals();
  const symbol = getPaymentSymbol();
  const tokenAddress = getMarketplaceTokenAddress();
  const escrow = getPostingEscrowAddress();
  const batch = batchSupport(postingChain);
  // A run pays only the escrow and token this build knows for the posting
  // chain (lib/bulkCalls): a backend that names others gets no run.
  const pinCheck = useMemo(() => {
    try {
      return { pins: pinnedContracts(postingChain, { escrow, token: tokenAddress }), error: null };
    } catch (error) {
      return { pins: null, error };
    }
  }, [postingChain, escrow, tokenAddress]);
  const { isAuthenticated } = useAuth();
  const { embeddedAddress } = useWallet();
  const { activeChain } = useChain();
  const address = useChainAddress();
  const accountWallets = useAccountWallets();
  const { data: walletClient } = useWalletClient();
  const { sendTransaction } = useSendTransaction();

  // Privy's embedded-wallet send, with this run's UI options (lib/bulkWallet).
  const privySend = useCallback<PrivySend>(
    (input, options) => sendTransaction({
      to: input.to,
      data: input.data,
      chainId: input.chainId,
      ...(input.value ? { value: input.value } : {}),
      ...(input.gasLimit ? { gasLimit: input.gasLimit } : {}),
    }, options),
    [sendTransaction],
  );

  // ── Input ────────────────────────────────────────────────────────────────
  // The Templates page links here with ?source=template&template=<id>.
  const [searchParams] = useSearchParams();
  const [source, setSource] = useState<Source>(() => (searchParams.get('source') === 'template' ? 'template' : 'file'));
  const [fileName, setFileName] = useState('');
  const [fileText, setFileText] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [templateId, setTemplateId] = useState(() => (/^\d+$/.test(searchParams.get('template') ?? '') ? searchParams.get('template')! : ''));
  const [readError, setReadError] = useState<unknown>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const templatesQuery = useQuery({
    queryKey: ['bulk-templates', isAuthenticated],
    enabled: source === 'template',
    queryFn: async (): Promise<TaskTemplate[]> => {
      const [mine, pub] = await Promise.all([
        isAuthenticated ? getMyTemplates().catch(() => [] as TaskTemplate[]) : Promise.resolve([] as TaskTemplate[]),
        getPublicTemplates(50, 0).then((r) => r.templates).catch(() => [] as TaskTemplate[]),
      ]);
      const seen = new Set(mine.map((t) => t.id));
      return [...mine, ...pub.filter((t) => !seen.has(t.id))];
    },
  });
  const templates = templatesQuery.data ?? [];
  const template = templates.find((t) => String(t.id) === templateId) ?? null;

  async function readFile(file: File | undefined) {
    if (!file) return;
    setReadError(null);
    try {
      setFileText(await file.text());
      setFileName(file.name);
    } catch (e) {
      setReadError(e);
    }
  }

  const text = source === 'paste' ? pasteText : fileText;
  const textName = source === 'paste' ? undefined : fileName || undefined;

  // ── Checking ─────────────────────────────────────────────────────────────
  const [checked, setChecked] = useState<CheckedRows | null>(null);
  const [fileIssues, setFileIssues] = useState<RowIssue[]>([]);
  const [unknownColumns, setUnknownColumns] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (!text.trim()) {
      setChecked(null);
      setFileIssues([]);
      setUnknownColumns([]);
      return;
    }
    const parsed = parseBulkText(text, textName);
    let raw = parsed.rows;
    let issues = [...parsed.issues];
    let unknown = parsed.unknownColumns;
    if (source === 'template') {
      if (!template) {
        setChecked(null);
        setFileIssues([{ row: 0, message: 'Pick a template, then add a file with one row of values per task.' }]);
        setUnknownColumns([]);
        return;
      }
      const applied = applyTemplate(raw, template);
      raw = applied.rows;
      issues = issues.concat(applied.issues);
      const vars = new Set(templateVariables(template.description));
      unknown = unknown.filter((c) => !vars.has(c));
    }
    void checkRows(raw, decimals, symbol).then((res) => {
      if (cancelled) return;
      // A row the file or the template flagged can't be posted either.
      const blocked = new Set(issues.filter((i) => i.row > 0).map((i) => i.row));
      setChecked({ rows: res.rows.filter((r) => !blocked.has(r.row)), issues: [...issues.filter((i) => i.row > 0), ...res.issues].sort((a, b) => a.row - b.row) });
      setFileIssues(issues.filter((i) => i.row === 0));
      setUnknownColumns(unknown);
    });
    return () => { cancelled = true; };
  }, [text, textName, source, template, decimals, symbol]);

  // ── Progress, kept per wallet (lib/bulkRunStore) ─────────────────────────
  const [statuses, setStatuses] = useState<Record<string, StoredStatus>>({});
  // The statuses as last written. A change is saved from here at once, not in
  // a state updater React may run after the engine has moved on: a row marked
  // 'sending' must be in storage before its transaction goes to the wallet.
  const statusesRef = useRef(statuses);
  const startedAtRef = useRef(0);
  const showStatuses = useCallback((next: Record<string, StoredStatus>) => {
    statusesRef.current = next;
    setStatuses(next);
  }, []);

  useEffect(() => {
    const run = address ? loadRun(address) : null;
    showStatuses(run ? settleInFlight(run.statuses) : {});
    startedAtRef.current = run?.startedAt ?? 0;
  }, [address, showStatuses]);

  /** Record a row's status, saved before it returns; false when it could not be saved. */
  const updateStatus = useCallback((fingerprint: string, row: number, status: RowStatus): boolean => {
    const next = { ...statusesRef.current, [fingerprint]: { ...status, row } };
    if (!startedAtRef.current) startedAtRef.current = Date.now();
    const saved = !!address && saveRun(address, { v: 1, startedAt: startedAtRef.current, updatedAt: Date.now(), fileName: fileName || undefined, statuses: next });
    showStatuses(next);
    return saved;
  }, [address, fileName, showStatuses]);

  const rows = useMemo(() => checked?.rows ?? [], [checked]);
  const sendable = rows.filter((r) => isSendable(statuses[r.fingerprint]));
  const totals = bulkTotals(sendable);
  const counts = rows.reduce<Partial<Record<BulkState, number>>>((c, r) => {
    const state = statuses[r.fingerprint]?.state ?? 'queued';
    c[state] = (c[state] ?? 0) + 1;
    return c;
  }, {});
  const tried = rows.length - (counts.queued ?? 0);
  const embeddedSigner = !!embeddedAddress && !!address && embeddedAddress.toLowerCase() === address.toLowerCase();
  // Only known once a wallet is connected: the embedded wallet sends without prompts.
  const promptsPerTx = !!address && isDirectSigned(postingChain) && !embeddedSigner;
  const amountText = (raw: bigint) => formatUnits(raw, decimals).replace(/\.0$/, '');
  const plan = plannedTransactions(sendable.length, { batch, chunkSize: DEFAULT_CHUNK, needsApproval: true, promptsPerTx });
  const issuesByRow = useMemo(() => {
    const m = new Map<number, string[]>();
    for (const i of checked?.issues ?? []) m.set(i.row, [...(m.get(i.row) ?? []), i.message]);
    return m;
  }, [checked]);

  // ── Running ──────────────────────────────────────────────────────────────
  const [runState, setRunState] = useState<'idle' | 'running' | 'paused' | 'finished'>('idle');
  const [runError, setRunError] = useState<unknown>(null);
  const [confirming, setConfirming] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  /** The row whose "queue it again" is being confirmed. */
  const [requeueing, setRequeueing] = useState<string | null>(null);
  const pauseRef = useRef(false);
  const running = runState === 'running';

  // Closing the tab mid-run stops it; the progress kept here lets it resume.
  useEffect(() => {
    if (!running) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [running]);

  async function start() {
    setConfirming(false);
    if (!walletClient || !address) return;
    setRunError(null);
    pauseRef.current = false;
    setRunState('running');
    try {
      // This build's escrow and token, or no run: nothing is approved or sent
      // to an address only the backend named.
      const pins = pinnedContracts(postingChain, { escrow, token: tokenAddress });
      const token = await postingToken();
      const getSigner = () => new BrowserProvider(walletClient.transport).getSigner();
      const signerAddress = await (await getSigner()).getAddress();
      // A wallet that isn't on this account would pay for tasks the backend
      // then refuses to list (lib/accountWallet.ts): refused before anything.
      const unlinked = unlinkedSignerError(signerAddress, accountWallets, "tasks paid from it couldn't be listed");
      if (unlinked) throw new Error(unlinked);
      const signer = bulkSigner({ chain: postingChain, from: signerAddress, embeddedAddress, privySend, getSigner });
      const reader = providerFor(postingChain);
      const rowOf = new Map(rows.map((r) => [r.fingerprint, r.row]));
      const deps: BulkDeps = {
        poster: address,
        pins,
        prepare: prepareBrief,
        executors: () => fetchWrapTargets(token),
        wrap: (taskHash, key, executors) => wrapKeyToExecutors(taskHash, key, executors, '[PostMany]'),
        seal: (key) => sealToKeyCustody(key, token, '[PostMany]'),
        upload: (blob) => uploadBrief(blob, token, activeChain),
        uploadMany: (blobs) => uploadBriefs(blobs, token),
        buildOne: (body) => authedPost<{ unsignedTx: UnsignedTx; chain?: string; chainId?: number }>('/api/v1/tasks', body, token),
        buildBatch: (tasks) => authedPost<{ unsignedTx: UnsignedTx; chain?: string; chainId?: number }>('/api/v1/tasks/batch', { token: pins.token, tasks }, token),
        ensureAllowance: (total) => ensureTotalAllowance({ signer, provider: reader, pins, owner: signerAddress, total }),
        send: signer.send,
        indexOne: (body) => postWithRetry<{ onChainTaskId?: string | null }>('/api/v1/a2a/tasks/index', body, token, { tag: '[PostMany]' }),
        indexBatch: (txHash, isUserOp, tasks) =>
          postWithRetry<{ results: BatchIndexResult[] }>('/api/v1/a2a/tasks/index-batch', { txHash, isUserOp, tasks }, token, { tag: '[PostMany]' }),
        savePending: savePendingIndex,
        clearPending: clearPendingIndex,
        userOpDelay: () => new Promise((r) => setTimeout(r, 15_000)),
        describe: (err) => friendlyErrorText(err),
      };
      const toSend = rows.filter((r) => isSendable(statusesRef.current[r.fingerprint]));
      const result = await runBulkPost(toSend, deps, {
        batch,
        chunkSize: DEFAULT_CHUNK,
        onStatus: (fp, s) => updateStatus(fp, rowOf.get(fp) ?? 0, s),
        shouldPause: () => pauseRef.current,
      });
      setRunState(result === 'paused' ? 'paused' : 'finished');
    } catch (e) {
      setRunError(e);
      setRunState('paused');
    } finally {
      // A row the run left 'sending' (its wallet failed without a hash) reads
      // as a reload would show it: maybe paid, checked by hand.
      showStatuses(settleInFlight(statusesRef.current));
    }
  }

  async function retryListing(fingerprint: string) {
    const st = statuses[fingerprint];
    if (!st?.taskHash || !address) return;
    const entry = listPendingIndex(address).find((e) => e.taskHash.toLowerCase() === st.taskHash!.toLowerCase());
    if (!entry) {
      updateStatus(fingerprint, st.row, { ...st, state: 'unknown', error: 'This browser has no saved listing request for this task. Check My tasks before posting it again.' });
      return;
    }
    setRetrying(fingerprint);
    try {
      const resp = await retryPendingListing(entry, await postingToken());
      clearPendingIndex(entry.taskHash);
      updateStatus(fingerprint, st.row, { state: 'done', taskHash: st.taskHash, txHash: st.txHash, taskId: resp.onChainTaskId ?? null });
    } catch (e) {
      updateStatus(fingerprint, st.row, { ...st, state: 'unlisted', error: `Still not listed: ${friendlyErrorText(e)} Your payment stays in escrow.` });
    } finally {
      setRetrying(null);
    }
  }

  function downloadResults() {
    download(
      `${(fileName || 'tasks').replace(/\.[^.]+$/, '')}.results.csv`,
      resultsCsv(rows.map((r) => {
        const s = statuses[r.fingerprint];
        return { row: r.row, status: STATE_VIEW[s?.state ?? 'queued'].text, taskHash: s?.taskHash, taskId: s?.taskId, txHash: s?.txHash, error: s?.error };
      })),
    );
  }

  /** The poster checked a may-have-been-paid row and says it wasn't: it goes
   *  back in the queue for the next run. Offered only without a transaction
   *  hash (lib/bulkRunStore mayRequeue). */
  function requeue() {
    const fingerprint = requeueing;
    setRequeueing(null);
    const st = fingerprint ? statusesRef.current[fingerprint] : undefined;
    if (!fingerprint || !st || !mayRequeue(st)) return;
    updateStatus(fingerprint, st.row, { state: 'queued' });
  }

  function forgetRun() {
    if (address) clearRun(address);
    showStatuses({});
    startedAtRef.current = 0;
    setRunState('idle');
    setRunError(null);
  }

  const escrowTotal = amountText(totals.totalRaw);
  const hasRun = tried > 0;

  return (
    <>
      <div>
        <Breadcrumb items={['tasks', 'post many']} />
        <PageHeader
          title="Post many tasks."
          titleMuted="One file, one confirmation."
          right={<ButtonLink to="/tasks/new" variant="outline" label="Post one task" />}
        />

        {/* 01 · Input */}
        <div className="card-dark rounded-3xl p-6 sm:p-8 mb-4">
          <SectionRule num="01" title="Add your tasks" />
          <div className="space-y-5">
            <RadioPills
              label="Source"
              value={source}
              disabled={running}
              onChange={setSource}
              options={[['file', 'Upload'], ['paste', 'Paste'], ['template', 'Template']]}
            />

            {source === 'template' && (
              <FormField label="Template" hint="Each {{name}} in the template's brief is filled from a column of the same name.">
                <FormSelect value={templateId} onChange={(e) => setTemplateId(e.target.value)} disabled={running}>
                  <option value="">{templatesQuery.isLoading ? 'Loading templates…' : 'Pick a template…'}</option>
                  {templates.map((t) => (
                    <option key={t.id} value={String(t.id)}>{t.name}</option>
                  ))}
                </FormSelect>
                {template && (
                  <p className="mt-2 text-xs text-ink-3 leading-relaxed">
                    {templateVariables(template.description).length > 0
                      ? <>Columns it needs: {templateVariables(template.description).map((v) => <code key={v} className="font-mono text-ink-2 mr-1.5">{v}</code>)}</>
                      : 'This template has no {{variables}}: every row posts the same brief, so give each row its own reward or instructions.'}
                  </p>
                )}
              </FormField>
            )}

            {source === 'paste' ? (
              <FormField label="Tasks" hint="CSV with a header row, or one JSON object per line.">
                <FormTextarea
                  rows={8}
                  className="font-mono text-[13px]"
                  value={pasteText}
                  disabled={running}
                  onChange={(e) => setPasteText(e.target.value)}
                  placeholder={'instructions,reward,privacy\n"Summarise this article in five bullets",0.5,public'}
                />
              </FormField>
            ) : (
              <div
                className="rounded-2xl border border-dashed border-line-2 p-6 sm:p-8 flex flex-col items-center text-center gap-3"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (!running) void readFile(e.dataTransfer.files?.[0]);
                }}
              >
                <span className="w-11 h-11 rounded-full border border-line flex items-center justify-center text-ink-3">
                  <Icon name="plus" size={18} />
                </span>
                <div className="text-sm text-ink">
                  {fileName ? <span className="font-medium">{fileName}</span> : source === 'template' ? 'Drop a CSV of values here' : 'Drop a CSV or JSONL file here'}
                </div>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <Button variant="outline" size="sm" label={fileName ? 'Choose another file' : 'Choose a file'} disabled={running} onClick={() => fileInput.current?.click()} />
                  <Button variant="ghost" size="sm" label="Download an example" onClick={() => download('blindmarket-tasks-example.csv', EXAMPLE_CSV)} />
                </div>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".csv,.jsonl,.ndjson,.txt,text/csv"
                  className="hidden"
                  onChange={(e) => {
                    void readFile(e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />
              </div>
            )}

            <details className="group rounded-2xl border border-line px-4 py-3">
              <summary className="cursor-pointer text-sm text-ink-2 list-none flex items-center justify-between">
                Columns
                <Icon name="plus" size={14} className="text-ink-3 transition-transform duration-240 group-open:rotate-45" />
              </summary>
              <ul className="mt-3 grid gap-x-6 gap-y-1.5 sm:grid-cols-2 text-xs text-ink-3 leading-relaxed">
                <li><code className="font-mono text-ink-2">instructions</code> the brief (required)</li>
                <li><code className="font-mono text-ink-2">reward</code> e.g. 2.5, or <code className="font-mono text-ink-2">amount</code> in the smallest unit</li>
                <li><code className="font-mono text-ink-2">duration</code> seconds, 3600 to 7776000 (default 86400)</li>
                <li><code className="font-mono text-ink-2">privacy</code> public or private (default private)</li>
                <li><code className="font-mono text-ink-2">verification</code> auto or manual (default auto)</li>
                <li><code className="font-mono text-ink-2">zone</code> where the work applies (default global)</li>
                <li><code className="font-mono text-ink-2">routing_summary</code> a public one-liner for the task board</li>
                <li><code className="font-mono text-ink-2">capabilities</code> separated by ; and <code className="font-mono text-ink-2">target</code> a single executor</li>
              </ul>
            </details>

            <ErrorNotice error={readError} title="Couldn't read the file" />
            {fileIssues.length > 0 && (
              <div className="rounded-2xl border border-[color:color-mix(in_srgb,var(--bb-err)_40%,transparent)] bg-[color:color-mix(in_srgb,var(--bb-err)_6%,transparent)] p-4 text-sm text-ink-2 space-y-1">
                {fileIssues.map((i) => <p key={i.message}>{i.message}</p>)}
              </div>
            )}
            {unknownColumns.length > 0 && (
              <p className="text-xs text-ink-3">
                Not used: {unknownColumns.map((c) => <code key={c} className="font-mono text-ink-2 mr-1.5">{c}</code>)}
                (the columns this page reads are {KNOWN_COLUMNS.filter((c) => c !== 'instructions_file').join(', ')}).
              </p>
            )}
          </div>
        </div>

        {/* 02 · Review and run */}
        {checked && (
          <div className="card-dark rounded-3xl p-6 sm:p-8">
            <SectionRule num="02" title={hasRun ? 'Progress' : 'Review'} />

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
              <Stat label={hasRun ? 'Left to post' : 'Ready to post'} value={String(sendable.length)} sub={`${rows.length} valid of ${rows.length + new Set((checked.issues ?? []).map((i) => i.row)).size} rows`} />
              <Stat label="Escrow" value={`${escrowTotal} ${symbol}`} sub={`${WORKER_SHARE_PCT}% to workers, ${PLATFORM_FEE_PCT}% fee`} />
              <Stat label="Public · private" value={`${totals.publicCount} · ${totals.privateCount}`} sub={totals.privateCount > 0 ? 'Private briefs are encrypted here' : 'Public briefs are readable by anyone'} />
              <Stat
                label="Transactions"
                value={String(plan.transactions)}
                sub={!address ? 'Connect a wallet to see prompts' : promptsPerTx ? `${plan.walletPrompts} wallet prompts` : 'No wallet prompts after you confirm'}
              />
            </div>

            <p className="text-xs text-ink-3 leading-relaxed mb-5">
              {batch.supported
                ? `The escrow takes up to ${batch.maxBatch} tasks per transaction; this run sends them ${plan.chunk} at a time, after one approval for the total.`
                : 'One transaction per task, after one approval for the total.'}
            </p>

            {promptsPerTx && sendable.length > 1 && (
              <div className="flex gap-2.5 rounded-xl border border-[color:color-mix(in_srgb,var(--bb-warn)_40%,transparent)] bg-[color:color-mix(in_srgb,var(--bb-warn)_6%,transparent)] px-4 py-3 mb-5">
                <Icon name="alert" size={15} className="text-warn shrink-0 mt-0.5" />
                <p className="text-xs text-ink-2 leading-relaxed">
                  Your wallet will ask you to approve each of the {plan.transactions} transactions. For big runs the CLI signs them for you:{' '}
                  <code className="font-mono text-ink">blind post-tasks --file tasks.csv</code>.
                </p>
              </div>
            )}

            {hasRun && (
              <div className="mb-5 space-y-2">
                <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={rows.length} aria-valuenow={counts.done ?? 0}>
                  <div className="h-full bg-accent transition-[width] duration-240 ease-bb" style={{ width: `${rows.length ? ((counts.done ?? 0) / rows.length) * 100 : 0}%` }} />
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-3">
                  <span><span className="text-ink font-medium">{counts.done ?? 0}</span> posted</span>
                  {(counts.unlisted ?? 0) > 0 && <span className="text-warn">{counts.unlisted} paid, not listed</span>}
                  {(counts.failed ?? 0) > 0 && <span className="text-err">{counts.failed} not posted</span>}
                  {(counts.unknown ?? 0) > 0 && <span className="text-warn">{counts.unknown} to check</span>}
                  <span>{sendable.length} left</span>
                </div>
              </div>
            )}

            <div className="rounded-2xl border border-line overflow-hidden">
              <div className="max-h-[520px] overflow-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-surface-2 text-[11px] font-medium uppercase tracking-wider text-ink-3">
                    <tr>
                      <th className="text-left font-medium px-4 py-2.5 w-12">Row</th>
                      <th className="text-left font-medium px-4 py-2.5">Task</th>
                      <th className="text-right font-medium px-4 py-2.5 whitespace-nowrap hidden md:table-cell">Reward</th>
                      <th className="text-left font-medium px-4 py-2.5 hidden md:table-cell">Privacy</th>
                      <th className="text-left font-medium px-4 py-2.5 hidden md:table-cell">Ends</th>
                      <th className="text-left font-medium px-4 py-2.5 hidden md:table-cell">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {rows.map((r) => {
                      const s = statuses[r.fingerprint];
                      const view = STATE_VIEW[s?.state ?? 'queued'];
                      const statusTag = (
                        <Tag tone={view.tone} className="whitespace-nowrap">
                          {view.busy && <Spinner size={10} />}
                          {view.text}
                        </Tag>
                      );
                      return (
                        <tr key={r.fingerprint} className="align-top">
                          <td className="px-4 py-3 font-mono text-xs text-ink-3">{r.row}</td>
                          <td className="px-4 py-3 min-w-0">
                            <div className="text-ink break-words">{briefTitle(r.instructions)}</div>
                            {/* Phones: the reward, privacy and status columns are hidden, so they sit here. */}
                            <div className="md:hidden mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-xs text-ink-3">
                              <span className="font-mono text-ink">{amountText(r.amountRaw)} {symbol}</span>
                              <span className="capitalize">{r.privacy}</span>
                              <span>{shortDuration(r.durationSeconds)}</span>
                              {statusTag}
                            </div>
                            {s?.error && <div className="mt-1 text-xs text-ink-3 leading-relaxed break-words">{s.error}</div>}
                            {s?.state === 'done' && s.taskHash && (
                              <a href={`/tasks/${s.taskHash}`} className="mt-1 inline-block font-mono text-[11px] text-ink-3 hover:text-ink underline decoration-line-2 underline-offset-2">
                                {s.taskId ? `task #${s.taskId}` : `${s.taskHash.slice(0, 10)}…`}
                              </a>
                            )}
                            {s?.state === 'unlisted' && (
                              <div className="mt-2">
                                <Button variant="outline" size="sm" label={retrying === r.fingerprint ? 'Listing…' : 'Retry listing'} disabled={retrying !== null || running} onClick={() => retryListing(r.fingerprint)} />
                              </div>
                            )}
                            {s?.state === 'unknown' && (mayRequeue(s) ? (
                              <div className="mt-2 flex flex-wrap items-center gap-2">
                                <ButtonLink to="/tasks/mine" target="_blank" rel="noreferrer" variant="outline" size="sm" label="Open My tasks" />
                                <Button variant="ghost" size="sm" label="Queue it again" disabled={running} onClick={() => setRequeueing(r.fingerprint)} />
                              </div>
                            ) : s.txHash && (
                              <a href={`${explorerUrlFor(postingChain)}/tx/${s.txHash}`} target="_blank" rel="noreferrer" className="mt-1 inline-block font-mono text-[11px] text-ink-3 hover:text-ink underline decoration-line-2 underline-offset-2">
                                See the transaction
                              </a>
                            ))}
                          </td>
                          <td className="px-4 py-3 text-right font-mono whitespace-nowrap text-ink hidden md:table-cell">{amountText(r.amountRaw)}</td>
                          <td className="px-4 py-3 hidden md:table-cell text-ink-2 capitalize">{r.privacy}</td>
                          <td className="px-4 py-3 hidden md:table-cell text-ink-2">{shortDuration(r.durationSeconds)}</td>
                          <td className="px-4 py-3 hidden md:table-cell">{statusTag}</td>
                        </tr>
                      );
                    })}
                    {rows.length === 0 && (
                      <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-ink-3">No row can be posted yet. Fix the rows below.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {checked.issues.length > 0 && (
              <div className="mt-4 rounded-2xl border border-[color:color-mix(in_srgb,var(--bb-err)_35%,transparent)] p-4">
                <div className="text-sm font-medium text-ink mb-2">
                  {issuesByRow.size === 1 ? '1 row needs fixing' : `${issuesByRow.size} rows need fixing`} and will be skipped
                </div>
                <ul className="max-h-48 overflow-auto space-y-1 text-xs text-ink-2 leading-relaxed">
                  {[...issuesByRow.entries()].map(([row, messages]) => (
                    <li key={row}><span className="font-mono text-ink-3 mr-2">Row {row}</span>{messages.join(' ')}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mt-6 flex flex-wrap items-center gap-2">
              {!isAuthenticated ? (
                <SignInGate prompt="to post tasks" />
              ) : running ? (
                <Button variant="outline" label={pauseRef.current ? 'Pausing after this transaction…' : 'Pause'} onClick={() => { pauseRef.current = true; setRunState('running'); }} />
              ) : (
                <Button
                  variant="primary"
                  label={hasRun && sendable.length > 0 ? `Resume: post ${sendable.length} more` : sendable.length === 1 ? 'Post 1 task' : `Post ${sendable.length} tasks`}
                  disabled={sendable.length === 0 || !walletClient || !pinCheck.pins}
                  onClick={() => setConfirming(true)}
                />
              )}
              {hasRun && !running && <Button variant="outline" label="Download results" onClick={downloadResults} />}
              {hasRun && !running && <Button variant="ghost" label="Start over" onClick={forgetRun} />}
              {running && <span className="text-xs text-ink-3">Keep this tab open until it finishes.</span>}
            </div>
            {runState === 'finished' && sendable.length === 0 && (counts.unlisted ?? 0) === 0 && (
              <p className="mt-3 text-sm text-ok">All done. Your tasks are on the board.</p>
            )}
            {!runError && <ErrorNotice error={pinCheck.error} title="Posting is unavailable" className="mt-3" />}
            <ErrorNotice error={runError} title="The run stopped" className="mt-3" />
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirming}
        title={sendable.length === 1 ? 'Post 1 task?' : `Post ${sendable.length} tasks?`}
        description={
          <div className="space-y-2">
            <div className="rounded-lg bg-surface-2 p-3 space-y-1.5 font-mono text-xs">
              <div className="flex justify-between"><span className="text-ink-3">Tasks</span><span>{sendable.length}</span></div>
              <div className="flex justify-between"><span className="text-ink-3">Escrow total</span><span>{escrowTotal} {symbol}</span></div>
              <div className="flex justify-between"><span className="text-ink-3">Transactions</span><span>{plan.transactions}</span></div>
              <div className="flex justify-between"><span className="text-ink-3">Wallet prompts</span><span>{promptsPerTx ? plan.walletPrompts : 'none'}</span></div>
            </div>
            <p className="text-xs text-ink-3 leading-relaxed">
              You approve the total once. Each task's reward is locked in escrow as it is posted; network gas is paid on top.
              {!promptsPerTx && ' Your BlindMarket wallet sends the transactions without asking again.'}
            </p>
          </div>
        }
        confirmLabel="Approve and post"
        onConfirm={() => void start()}
        onCancel={() => setConfirming(false)}
      />

      <ConfirmDialog
        open={requeueing !== null}
        title="Queue this row again?"
        description={
          <div className="space-y-2">
            <p>
              Only if its first payment didn't go through. Look for the task in{' '}
              <a href="/tasks/mine" target="_blank" rel="noreferrer" className="text-ink underline decoration-line-2 underline-offset-2">My tasks</a>
              {address ? (
                <>
                  {' '}and for a payment to the escrow in{' '}
                  <a href={`${explorerUrlFor(postingChain)}/address/${address}`} target="_blank" rel="noreferrer" className="text-ink underline decoration-line-2 underline-offset-2">your wallet's activity</a>.
                </>
              ) : '.'}
            </p>
            <p className="text-xs text-ink-3">A payment that went through but was never listed shows only in your wallet's activity. If you find one, don't queue this row: posting it again pays for it twice.</p>
          </div>
        }
        confirmLabel="Queue it again"
        danger
        onConfirm={requeue}
        onCancel={() => setRequeueing(null)}
      />
    </>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4 min-w-0">
      <div className="text-[10px] font-mono font-semibold uppercase tracking-widest text-ink-3 mb-1.5 truncate">{label}</div>
      <div className="text-lg font-medium text-ink font-mono truncate">{value}</div>
      <div className="mt-1 text-[11px] text-ink-3 leading-snug">{sub}</div>
    </div>
  );
}
