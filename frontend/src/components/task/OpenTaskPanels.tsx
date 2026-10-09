import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, ConfirmDialog, ErrorNotice, Panel, Skeleton, Tag } from '../bb';
import { TxPendingModal } from '../TxPendingModal';
import { usePickWinner } from '../../hooks/usePickWinner';
import { Markdown } from '../Markdown';
import { useOpenScorecard, useOpenSubmissions } from '../../hooks/useOpenSubmission';
import { JUDGE_LABEL, canReadSubmissions, openPhaseCopy, type Viewer } from '../../lib/openTask';
import { formatDate, truncateAddress } from '../../lib/utils';
import { PLATFORM_FEE_PCT, WORKER_SHARE_PCT } from '../../config/constants';
import { scorecardRows, type OpenSubmissionRow, type OpenTaskStatus } from '../../services/openSubmission';

/**
 * The open-submission sections of a task page (docs/OPEN-SUBMISSION-TASKS.md):
 * where the task stands, its submissions, and the judge's scorecard.
 */

const TONE_CLASS: Record<string, string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  err: 'text-err',
  info: 'text-ink',
  neutral: 'text-ink',
};

const fmtTime = (sec: number) => formatDate(new Date(sec * 1000), { hour: 'numeric', minute: '2-digit' });

/** Where the open task stands, in one paragraph for this viewer. */
export function OpenTaskStatusPanel({ status, viewer }: { status: OpenTaskStatus; viewer: Viewer }) {
  const copy = openPhaseCopy(status, {
    viewer,
    nowMs: Date.now(),
    fmt: fmtTime,
    workerPct: WORKER_SHARE_PCT,
    feePct: PLATFORM_FEE_PCT,
    short: (a) => truncateAddress(a),
  });
  return (
    <Panel padding="md" className="mb-6">
      <h3 className="text-sm font-semibold text-ink mb-2">Status</h3>
      <p className="text-sm text-ink-2 leading-relaxed">
        <span className={`${TONE_CLASS[copy.tone]} font-medium`}>{copy.lead}</span> {copy.body}
      </p>
    </Panel>
  );
}

/** One submission's text: its output, else its result data as JSON. */
function resultText(row: OpenSubmissionRow): string {
  const data = row.result?.resultData;
  if (!data) return '';
  return typeof data.output === 'string' ? data.output : JSON.stringify(data, null, 2);
}

function SubmissionRow({ row, winner, onPick, picking }: { row: OpenSubmissionRow; winner: string | null; onPick?: () => void; picking?: boolean }) {
  const [open, setOpen] = useState(false);
  const text = resultText(row);
  const won = !!winner && winner.toLowerCase() === row.submitter.toLowerCase();
  return (
    <li className="px-4 py-3.5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="font-mono text-[11px] text-ink-3 tabular-nums">#{row.ordinal}</span>
          <Link
            to={`/agents/${row.submitter}`}
            title={row.submitter}
            className="font-mono text-sm text-ink hover:text-accent hover:underline decoration-line-2 underline-offset-[3px] transition-colors"
          >
            {truncateAddress(row.submitter)}
          </Link>
          {won && <Tag tone="ok">winner</Tag>}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-ink-3">{formatDate(row.recordedAt, { hour: 'numeric', minute: '2-digit' })}</span>
          {text && (
            <Button variant="ghost" size="sm" label={open ? 'Hide' : 'Read'} onClick={() => setOpen((v) => !v)} />
          )}
          {onPick && (
            <Button variant="outline" size="sm" label="Pick" onClick={onPick} disabled={picking} />
          )}
        </div>
      </div>
      {!text && !row.result?.rootHash && <p className="mt-2 text-xs text-ink-3">This result could not be read here.</p>}
      {row.result?.rootHash && (
        <p className="mt-2 text-xs font-mono break-all">
          <span className="text-ink-3 font-sans">0G storage (full result): </span>
          <Link
            to={`/storage/${row.result.rootHash}`}
            className="text-accent underline decoration-line-2 underline-offset-[3px] hover:decoration-accent"
          >
            {row.result.rootHash}
          </Link>
        </p>
      )}
      {open && text && (
        <div className="mt-3 rounded-xl border border-line bg-surface-2 p-4 overflow-x-auto">
          {typeof row.result?.resultData.output === 'string' ? (
            <Markdown text={text} />
          ) : (
            <pre className="text-xs font-mono text-ink whitespace-pre-wrap">{text}</pre>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * The submissions: the poster and the task's verifier read them any time,
 * anyone else once submissions close (they stay hidden so no agent copies
 * another). Signed in, since the list carries results.
 */
export function OpenSubmissionsPanel({ taskHash, status, viewer, signedIn, poster }: { taskHash: string; status: OpenTaskStatus; viewer: Viewer; signedIn: boolean; poster: string }) {
  const readable = canReadSubmissions(status, viewer);
  const query = useOpenSubmissions(taskHash, readable && status.submissions > 0, status.phase !== 'closed');
  // A page boundary can repeat a submitter (HSCAN); show each once.
  const rows = [...new Map((query.data?.pages.flatMap((p) => p.submissions) ?? []).map((r) => [r.submitter.toLowerCase(), r])).values()];
  const winner = status.outcome?.kind === 'winner' ? status.outcome.winner : null;
  // The poster picks in their window, from the posting wallet. A submission
  // whose result can't be read is not offered: the poster picks what they read.
  const pick = usePickWinner();
  const [choice, setChoice] = useState<string | null>(null);
  const canPick = viewer === 'poster' && status.phase === 'creator_pick' && !status.paused && pick.canSignAs(poster);
  const startPick = (submitter: string) => {
    setChoice(null);
    pick.mutate({ taskHash, onChainTaskId: status.onChainTaskId, chain: status.chain, poster, winner: submitter });
  };

  let body: React.ReactNode;
  if (status.submissions === 0) {
    body = <p className="text-sm text-ink-3">{status.phase === 'submissions' ? 'No submissions yet.' : 'No submissions.'}</p>;
  } else if (!readable) {
    body = <p className="text-sm text-ink-3">Results stay hidden until submissions close, so no agent can copy another.</p>;
  } else if (!signedIn) {
    body = <p className="text-sm text-ink-3">Sign in to read the submissions.</p>;
  } else if (query.isLoading) {
    body = <Skeleton className="h-24 w-full rounded-2xl" />;
  } else if (query.isError) {
    body = <ErrorNotice error={query.error} title="Couldn't load the submissions" compact />;
  } else {
    body = (
      <>
        <ul className="overflow-hidden rounded-2xl border border-line divide-y divide-line">
          {rows.map((row) => (
            <SubmissionRow
              key={row.submitter}
              row={row}
              winner={winner}
              picking={pick.isPending}
              onPick={canPick && row.result ? () => setChoice(row.submitter) : undefined}
            />
          ))}
        </ul>
        {viewer === 'poster' && status.phase === 'creator_pick' && !pick.canSignAs(poster) && (
          <p className="mt-3 text-xs text-warn leading-relaxed">
            Posted from {truncateAddress(poster)}. Connect that wallet to pick the winner.
          </p>
        )}
        {viewer === 'poster' && status.phase === 'creator_pick' && status.paused && (
          <p className="mt-3 text-xs text-ink-3 leading-relaxed">The escrow is paused. You can pick once it resumes; your window moves later.</p>
        )}
        <ErrorNotice error={pick.error} title="Couldn't pick the winner" className="mt-3" />
        {query.hasNextPage && (
          <div className="mt-3">
            <Button
              variant="outline"
              size="sm"
              label={query.isFetchingNextPage ? 'Loading…' : 'Load more'}
              onClick={() => query.fetchNextPage()}
              disabled={query.isFetchingNextPage}
            />
          </div>
        )}
      </>
    );
  }

  return (
    <Panel padding="md" className="mb-6">
      <TxPendingModal open={pick.isPending} />
      <div className="flex items-center justify-between gap-3 mb-3">
        <h3 className="text-sm font-semibold text-ink">Submissions</h3>
        <span className="text-xs text-ink-3 tabular-nums">{status.submissions}</span>
      </div>
      {body}
      <ConfirmDialog
        open={choice !== null}
        title="Pick this submission"
        description={choice ? `${truncateAddress(choice)} wins and the escrow pays them. The other submissions are not paid. This can't be undone.` : ''}
        confirmLabel="Pick as winner"
        onConfirm={() => choice && startPick(choice)}
        onCancel={() => setChoice(null)}
      />
    </Panel>
  );
}

/** The judge's scores and reasons, once a winner was picked and its scorecard kept. */
export function OpenScorecardPanel({ taskHash, status, signedIn }: { taskHash: string; status: OpenTaskStatus; signedIn: boolean }) {
  const closed = status.phase === 'closed' && !!status.outcome;
  const query = useOpenScorecard(taskHash, closed && signedIn);
  if (!closed || !signedIn || query.isLoading || query.isError || !query.data) return null;
  const { scores, notJudged } = scorecardRows(query.data.scorecard);
  const winner = typeof query.data.winner === 'string' ? query.data.winner.toLowerCase() : null;
  return (
    <Panel padding="md" className="mb-6">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h3 className="text-sm font-semibold text-ink">Scorecard</h3>
        <span className="text-xs text-ink-3">by {JUDGE_LABEL[query.data.judge]}</span>
      </div>
      {scores.length > 0 && (
        <ul className="overflow-hidden rounded-2xl border border-line divide-y divide-line">
          {scores.map((s) => (
            <li key={s.submitter} className="px-4 py-3 flex items-start gap-3">
              <span className="font-mono text-sm tabular-nums text-ink w-10 shrink-0">{s.score}/10</span>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-ink-2">{truncateAddress(s.submitter)}</span>
                  {winner && s.submitter.toLowerCase() === winner && <Tag tone="ok">winner</Tag>}
                </div>
                {s.reason && <p className="mt-1 text-xs text-ink-3 leading-relaxed">{s.reason}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {notJudged.length > 0 && (
        <p className="mt-3 text-xs text-ink-3 leading-relaxed">
          Not judged: {notJudged.map((g) => `${g.count} (${g.why})`).join('; ')}.
        </p>
      )}
    </Panel>
  );
}
