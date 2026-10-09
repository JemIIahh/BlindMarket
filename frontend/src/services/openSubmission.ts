import { authedGet, get } from '../lib/api';

/**
 * Open-submission tasks (docs/OPEN-SUBMISSION-TASKS.md): many agents submit,
 * one is picked. These read what the server exposes under /api/v1/a2a; every
 * route but the config answers 404 while the server has it off.
 */

/** GET /a2a/open-submission: public, answered whether the feature is on or off. */
export interface OpenSubmissionConfig {
  enabled: boolean;
  pickModes: Array<'agent' | 'creator'>;
  windows: { creatorMinSec: number; creatorMaxSec: number; verifierSec: number; backupSec: number };
  maxResultBytes: number;
  maxScorecardBytes: number;
}

export type OpenPhase = 'submissions' | 'creator_pick' | 'verifier_pick' | 'backup_pick' | 'admin' | 'closed';
export type OpenJudge = 'creator' | 'task_verifier' | 'backup' | 'admin';

/** GET /a2a/tasks/:hash/open-status: public, read from the escrow. */
export interface OpenTaskStatus {
  taskHash: string;
  onChainTaskId: string;
  chain: string;
  mode: 'agent' | 'creator';
  phase: OpenPhase;
  paused: boolean;
  submissions: number;
  windows: { submissionsEnd: number; creatorPickEnd: number | null; verifierPickEnd: number; backupPickEnd: number };
  outcome: { kind: 'winner' | 'void'; winner: string | null; judge: OpenJudge } | null;
  declined: { at: string } | null;
}

export interface OpenSubmissionRow {
  submitter: string;
  ordinal: number;
  evidenceHash: string;
  recordedAt: string;
  result: { resultData: Record<string, unknown>; rootHash: string | null } | null;
}

/** GET /a2a/tasks/:hash/submissions: the poster and verifier any time, others once submissions close. */
export interface OpenSubmissionsPage {
  submissions: OpenSubmissionRow[];
  /** '0' when there is no next page. */
  cursor: string;
  total: number;
}

export interface OpenScorecard {
  taskHash: string;
  outcome: 'winner' | 'void';
  judge: OpenJudge;
  winner: string | null;
  scorecardHash: string;
  scorecard: {
    winner?: string | null;
    submissions?: number;
    judged?: number;
    model?: string;
    judgedAt?: string;
    scores?: Array<{ submitter: string; score: number; reason?: string }>;
    laterRounds?: Array<Array<{ submitter: string; score: number; reason?: string }>>;
    notJudged?: Array<{ why: string; count: number; submitters?: string[] }>;
    [key: string]: unknown;
  };
}

export interface ScoreRow { submitter: string; score: number; reason?: string }

/**
 * A scorecard as the panel shows it: its scores, best first and one per
 * submitter, and why any submissions were not judged. The server keeps
 * whatever JSON a judge sent, so anything not shaped as expected is dropped
 * rather than trusted.
 */
export function scorecardRows(card: unknown): { scores: ScoreRow[]; notJudged: Array<{ why: string; count: number }> } {
  const c = card && typeof card === 'object' ? (card as Record<string, unknown>) : {};
  const seen = new Set<string>();
  const scores: ScoreRow[] = [];
  for (const s of Array.isArray(c.scores) ? c.scores : []) {
    if (!s || typeof s !== 'object') continue;
    const { submitter, score, reason } = s as Record<string, unknown>;
    if (typeof submitter !== 'string' || typeof score !== 'number' || !Number.isFinite(score)) continue;
    if (seen.has(submitter.toLowerCase())) continue;
    seen.add(submitter.toLowerCase());
    scores.push({ submitter, score, ...(typeof reason === 'string' && reason ? { reason } : {}) });
  }
  scores.sort((a, b) => b.score - a.score);
  const notJudged: Array<{ why: string; count: number }> = [];
  for (const g of Array.isArray(c.notJudged) ? c.notJudged : []) {
    if (!g || typeof g !== 'object') continue;
    const { why, count } = g as Record<string, unknown>;
    if (typeof why === 'string' && typeof count === 'number' && Number.isFinite(count)) notJudged.push({ why, count });
  }
  return { scores, notJudged };
}

export const getOpenSubmissionConfig = () => get<OpenSubmissionConfig>('/api/v1/a2a/open-submission');
export const getOpenTaskStatus = (taskHash: string) => get<OpenTaskStatus>(`/api/v1/a2a/tasks/${taskHash}/open-status`);
export const listOpenSubmissions = (taskHash: string, cursor = '0') =>
  authedGet<OpenSubmissionsPage>(`/api/v1/a2a/tasks/${taskHash}/submissions?cursor=${encodeURIComponent(cursor)}&limit=20`);
export const getOpenScorecard = (taskHash: string) => authedGet<OpenScorecard>(`/api/v1/a2a/tasks/${taskHash}/scorecard`);
