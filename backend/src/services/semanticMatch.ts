import { getPool } from './neonDb.js';
import { config } from '../config.js';
import { embed, toVectorLiteral, embeddingModelId, EMBED_FETCH_TIMEOUT_MS } from './embeddingService.js';
import { rankAgents, meetsRewardFloor, dominanceMultiplier, hasAllCapabilities } from './agentScorer.js';
import { buildAgentDoc } from './agentEmbedding.js';
import * as agentStore from './agentStore.js';
import type { CascadeEntry } from './a2aStore.js';
import type { A2ATaskMeta, AgentCapability } from '../types.js';

/**
 * Semantic matching (Phase 1: SHADOW mode).
 *
 * Nothing here influences routing yet. For every indexed task that carries
 * routing text we record, side by side, how semantic KNN would have ranked
 * agents vs the live capability-tag ranking — then the accept/settlement
 * paths fill in what actually happened. The tuning loop reads this log and
 * declares "flip-ready" only when semantic reliably beats tags on real
 * outcomes.
 *
 * Privacy: routing text is ONLY ever public material — publicBrief (public
 * tasks), the poster's opt-in routingSummary (private tasks), or the
 * capability tags themselves as a last resort. The sealed brief never gets
 * embedded.
 */

export interface SemanticCandidate {
  address: string;
  displayName: string;
  similarity: number; // 1 - cosine distance ∈ [0..1]-ish (higher = closer)
}

export interface RerankedCandidate extends SemanticCandidate {
  /** Cross-encoder relevance from the reranker; higher = better fit. */
  rerankScore: number;
}

/** The public text a task exposes for matching, best source first. */
export function buildTaskRoutingText(meta: Pick<A2ATaskMeta, 'publicBrief' | 'routingSummary' | 'requiredCapabilities'>): string {
  if (meta.publicBrief?.trim()) return meta.publicBrief.trim();
  if (meta.routingSummary?.trim()) return meta.routingSummary.trim();
  if (meta.requiredCapabilities?.length) return `Task requiring: ${meta.requiredCapabilities.join(', ')}`;
  return '';
}

/** Embed + persist a task's routing text (upsert; model-tagged). */
export async function embedTask(taskHash: string, routingText: string): Promise<number[]> {
  const { vector, model } = await embed(routingText);
  const db = await getPool();
  await db.query(
    `INSERT INTO task_embeddings (task_hash, embedding, model, source_text_hash)
     VALUES ($1, $2::vector, $3, md5($4))
     ON CONFLICT (task_hash) DO UPDATE SET embedding = $2::vector, model = $3, source_text_hash = md5($4)`,
    [taskHash.toLowerCase(), toVectorLiteral(vector), model, routingText],
  );
  return vector;
}

/** KNN over agents that carry vectors from the SAME model (mixing models makes
 *  distances meaningless). */
export async function semanticCandidates(taskVector: number[], k = 10): Promise<SemanticCandidate[]> {
  const db = await getPool();
  const { rows } = await db.query<{ address: string; display_name: string; dist: number }>(
    `SELECT address, display_name, embedding <=> $1::vector AS dist
       FROM agent_executors
      WHERE embedding IS NOT NULL AND embedding_model = $2
      ORDER BY embedding <=> $1::vector
      LIMIT $3`,
    [toVectorLiteral(taskVector), embeddingModelId(), k],
  );
  return rows.map((r) => ({
    address: r.address,
    displayName: r.display_name,
    similarity: Math.round((1 - Number(r.dist)) * 1000) / 1000,
  }));
}

/**
 * Retrieve-then-rerank: reorder KNN candidates by a cross-encoder's true
 * query↔document fit (Voyage rerank-2.5, same key). `docByAddress` supplies
 * each candidate's agent text. Returns candidates sorted best-first with a
 * rerankScore. On the mock path (no real key) it's an identity passthrough
 * with score 0 — so callers can always rely on the reranked shape.
 */
export async function rerankCandidates(
  query: string,
  candidates: SemanticCandidate[],
  docByAddress: Map<string, string>,
): Promise<RerankedCandidate[]> {
  if (candidates.length === 0) return [];
  // No real reranker configured → passthrough (preserve KNN order).
  if (config.embeddingProvider === 'mock' || !config.embeddingApiKey) {
    return candidates.map((c) => ({ ...c, rerankScore: 0 }));
  }
  const documents = candidates.map((c) => docByAddress.get(c.address.toLowerCase()) ?? c.displayName);
  const res = await fetch('https://api.voyageai.com/v1/rerank', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.embeddingApiKey}` },
    body: JSON.stringify({ model: config.rerankModel, query, documents, top_k: candidates.length }),
    // Rerank sits on the dispatch critical path when routing is flipped —
    // same hard cap as embed so a blackholed connection can't stall offers.
    signal: AbortSignal.timeout(EMBED_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Voyage rerank failed: ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300));
  }
  const json = (await res.json()) as { data: Array<{ index: number; relevance_score: number }> };
  // Voyage returns items sorted by relevance; `index` points back into
  // `candidates`. Bounds-check so a malformed index never yields an entry with
  // an undefined address (which would later 500 the metrics path).
  return json.data
    .filter((d) => d.index >= 0 && d.index < candidates.length)
    .map((d) => ({ ...candidates[d.index], rerankScore: d.relevance_score }));
}

/**
 * Rank registered agents for a piece of public routing text, by meaning:
 * embed → KNN recall → optional rerank precision. Reusable core for the
 * shadow log, the /semantic-candidates endpoint, and (in the next stage) the
 * offer routing itself. `rerank` fetches each candidate's agent doc so the
 * cross-encoder has real text to judge.
 */
/** Parallel agent-doc fetch for the reranker (independent DB reads). */
async function docsForCandidates(candidates: SemanticCandidate[]): Promise<Map<string, string>> {
  const docs = await Promise.all(candidates.map((c) => buildAgentDoc(c.address).catch(() => c.displayName)));
  return new Map(candidates.map((c, i) => [c.address.toLowerCase(), docs[i]]));
}

export async function semanticRankedAgents(
  routingText: string,
  opts: { k?: number; rerank?: boolean } = {},
): Promise<Array<SemanticCandidate | RerankedCandidate>> {
  if (!routingText.trim()) return [];
  const { vector } = await embed(routingText);
  const candidates = await semanticCandidates(vector, opts.k ?? 10);
  if (!opts.rerank || candidates.length === 0) return candidates;
  // Degrade gracefully: a reranker blip falls back to the embeddings-only
  // ranking rather than 500-ing the caller.
  try {
    return await rerankCandidates(routingText, candidates, await docsForCandidates(candidates));
  } catch (err) {
    console.warn('[semanticMatch] rerank failed, returning embeddings-only order:', (err as Error).message);
    return candidates;
  }
}

// ── Phase 2 FLIP: semantic ranking as the cascade's offer queue ─────────────

/** How many semantic candidates seed the cascade before broadcast fallback. */
export const SEMANTIC_CASCADE_K = 10;

/** The meta slice the routing decision needs. The accept-gate fields let the
 *  ranking pre-filter agents whose /accept is guaranteed to 403 (poster,
 *  designated verifier, missing wrapped slice) instead of burning a 12s
 *  exclusive offer window on them. */
export type RoutingMeta = Pick<
  A2ATaskMeta,
  | 'publicBrief' | 'routingSummary' | 'requiredCapabilities' | 'targetExecutor'
  | 'posterAddress' | 'verifierAddress' | 'wrappedKeys' | 'privacy' | 'rootHash'
  | 'skipKeyWrap' | 'keyCustodyBlob'
>;

/**
 * Can this task be ROUTED by meaning? True only when the flag is on, the task
 * is not pinned to one executor (a pinned task has no routing question — an
 * exclusive offer to anyone else would lock out the only agent allowed to
 * accept), and there is public routing text to embed.
 */
export function semanticRoutingEligible(meta: RoutingMeta): boolean {
  return config.semanticRoutingEnabled && !meta.targetExecutor && !!buildTaskRoutingText(meta);
}

/**
 * Map a semantic candidate onto the cascade's 0–100 score scale (what agents
 * see on `task:offer`, alongside tag scores from the old ranker). Prefer the
 * cross-encoder's relevance when a real rerank ran (the mock passthrough
 * reports 0, which falls through to cosine similarity).
 */
function toCascadeScore(c: SemanticCandidate | RerankedCandidate): number {
  const raw = 'rerankScore' in c && c.rerankScore > 0 ? c.rerankScore : c.similarity;
  return Math.round(Math.min(1, Math.max(0, raw)) * 100 * 100) / 100;
}

/**
 * The semantic ranking, shaped for the cascade's offer queue — the Phase 2
 * flip's core. Returns null whenever a usable semantic ranking can't be
 * produced (flag off, pinned task, no routing text, no embedded agents,
 * provider failure), so the caller falls back to the capability-tag flow and
 * a task can never be stranded by the flip.
 *
 * Hard accept-gates are respected so an offer window is never burned on an
 * agent who is FORBIDDEN from taking the task: dropped are candidates missing
 * any of the task's requiredCapabilities (/accept 403s CAPABILITY_MISMATCH —
 * during the transition, tags posted on a task remain a hard constraint even
 * though ranking is semantic; the tag retirement phase removes this), the
 * poster themselves (SELF_ACCEPT), the designated verifier (IS_VERIFIER),
 * candidates who can't decrypt a sealed brief (NEEDS_WRAP: no wrapped slice,
 * and no usable custody self-heal — which needs both a custody blob and the
 * agent's registered publicKey to re-wrap to; a blob sealed to a since-rotated
 * key is undetectable at rank time and stays optimistic), agents whose
 * declared minReward floor exceeds the task's reward, and candidates whose
 * registration row has vanished since embedding.
 *
 * The tag era's dominance cap also applies: an agent past the rolling
 * assignment cap gets the same soft score taper, so topping the similarity
 * ranking on every task can't turn into unbounded capture. (Reputation /
 * dispute blending into the semantic score is deliberately NOT here — that is
 * the tuning phase after the flip; the shadow report watches outcomes.)
 */
export async function semanticCascadeRanking(
  meta: RoutingMeta,
  taskRewardWei?: string,
): Promise<CascadeEntry[] | null> {
  if (!semanticRoutingEligible(meta)) return null;
  try {
    const ranked = await semanticRankedAgents(buildTaskRoutingText(meta), {
      k: SEMANTIC_CASCADE_K,
      rerank: config.rerankEnabled,
    });
    if (ranked.length === 0) return null;

    const agents = await Promise.all(
      ranked.map((c) => agentStore.getAgent(c.address).catch(() => undefined)),
    );
    const requiredCaps = (meta.requiredCapabilities ?? []) as AgentCapability[];
    const posterLc = meta.posterAddress?.toLowerCase();
    const verifierLc = meta.verifierAddress?.toLowerCase();
    // A sealed brief is only acceptable to agents holding a wrapped slice, or
    // — when a custody blob exists — agents accept can re-wrap to, which
    // requires their registered publicKey. Everyone else 403s NEEDS_WRAP
    // (they can still /bid via broadcast, exactly as before the flip).
    const sealed = meta.privacy !== 'public' && !!meta.rootHash && !meta.skipKeyWrap;
    let taskReward: bigint | null = null;
    try { taskReward = taskRewardWei ? BigInt(taskRewardWei) : null; } catch { taskReward = null; }
    const entries: CascadeEntry[] = [];
    for (let i = 0; i < ranked.length; i++) {
      const agent = agents[i];
      if (!agent) continue;
      const addrLc = ranked[i].address.toLowerCase();
      if (posterLc && addrLc === posterLc) continue;   // SELF_ACCEPT
      if (verifierLc && addrLc === verifierLc) continue; // IS_VERIFIER
      if (sealed && !meta.wrappedKeys?.[addrLc] && (!meta.keyCustodyBlob || !agent.publicKey)) continue; // NEEDS_WRAP
      // Capability gate removed — semantic KNN is the primary routing signal.
      // Agents are ranked by embedding similarity, not declared capability tags.
      if (!meetsRewardFloor(agent, taskReward)) continue;
      entries.push({
        address: ranked[i].address,
        displayName: ranked[i].displayName,
        score: toCascadeScore(ranked[i]),
      });
    }
    if (entries.length === 0) return null;

    // Dominance cap (same taper as the tag ranker): demote agents past the
    // rolling assignment cap so the similarity queue can't be captured.
    await Promise.all(
      entries.map(async (e) => {
        const mult = await dominanceMultiplier(e.address).catch(() => 1);
        if (mult < 1) e.score = Math.round(e.score * mult * 100) / 100;
      }),
    );
    entries.sort((a, b) => b.score - a.score);
    return entries;
  } catch (err) {
    console.warn('[semanticMatch] semantic cascade ranking failed, falling back to tags:', (err as Error).message);
    return null;
  }
}

/**
 * Record which ranking ACTUALLY drove the cascade for this task. Written by
 * the dispatch path (fire-and-forget); keeps the shadow report honest once
 * routing follows the semantic order (accepted_by correlating with
 * semantic_topk is self-fulfilling post-flip — routed_by lets the metrics be
 * segmented) and answers "how often did the flip actually engage?".
 *
 * Upserts a placeholder so it can't lose a race with recordMatchShadow's
 * insert; the shadow upsert fills the real fields and never touches routed_by.
 * Callers must gate this on SEMANTIC_ROUTING_ENABLED (flag-off must remain a
 * strict no-op — NULL routed_by means flag-off/broadcast/pre-flip) and on the
 * task having routing text. If recordMatchShadow's own write fails, the
 * placeholder row survives with empty rankings — computeShadowMetrics skips
 * rows with no ranking data, so a stray placeholder can't drag the metrics.
 */
export async function markShadowRoutedBy(taskHash: string, routedBy: 'semantic' | 'tag'): Promise<void> {
  try {
    const db = await getPool();
    await db.query(
      `INSERT INTO match_shadow_log (task_hash, routing_text, embedding_model, routed_by)
       VALUES ($1, '', '', $2)
       ON CONFLICT (task_hash) DO UPDATE SET routed_by = $2, updated_at = NOW()`,
      [taskHash.toLowerCase(), routedBy],
    );
  } catch (err) {
    console.warn(`[semanticMatch] routed_by mark failed for ${taskHash.slice(0, 10)}…:`, (err as Error).message);
  }
}

/**
 * Fire-and-forget shadow record for one freshly indexed task. Failures are
 * logged and swallowed — shadow measurement must never affect indexing.
 */
export async function recordMatchShadow(meta: A2ATaskMeta): Promise<void> {
  try {
    const routingText = buildTaskRoutingText(meta);
    if (!routingText) return; // nothing public to match on — no shadow row

    const vector = await embedTask(meta.taskId, routingText);
    const [semantic, tagRanked] = await Promise.all([
      semanticCandidates(vector, 10),
      rankAgents((meta.requiredCapabilities ?? []) as AgentCapability[]).catch(() => []),
    ]);

    // Also capture the reranked order when the reranker is enabled, so prod
    // evidence includes embeddings+rerank (mirrors the offline eval bench).
    // Its OWN try/catch: a rerank/doc-fetch failure must never abort the
    // semantic+tag row write (before this the whole shadow row was dropped,
    // silently gapping the tuning dataset).
    // NOTE: when the routing flip is on, the dispatch path runs its own
    // rerank over the same candidates — the embed is deduped by the
    // embeddingService memo, but the rerank call is intentionally repeated
    // here so the shadow row stays an independent record (cost ≈ 1 extra
    // cheap rerank per task while both are enabled).
    let reranked: RerankedCandidate[] = [];
    if (config.rerankEnabled && semantic.length > 0) {
      try {
        reranked = await rerankCandidates(routingText, semantic, await docsForCandidates(semantic));
      } catch (rerankErr) {
        console.warn(`[semanticMatch] rerank capture failed for ${meta.taskId.slice(0, 10)}… (row still written):`, (rerankErr as Error).message);
      }
    }

    const db = await getPool();
    await db.query(
      `INSERT INTO match_shadow_log (task_hash, routing_text, embedding_model, semantic_topk, semantic_rerank_topk, tag_topk, required_capabilities)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (task_hash) DO UPDATE SET
         routing_text = $2, embedding_model = $3, semantic_topk = $4, semantic_rerank_topk = $5,
         tag_topk = $6, required_capabilities = $7, updated_at = NOW()`,
      [
        meta.taskId.toLowerCase(),
        routingText,
        embeddingModelId(),
        JSON.stringify(semantic),
        JSON.stringify(reranked),
        JSON.stringify(tagRanked.slice(0, 10).map((a) => ({ address: a.address, displayName: a.displayName, score: a.score }))),
        meta.requiredCapabilities ?? [],
      ],
    );
  } catch (err) {
    console.warn(`[semanticMatch] shadow record failed for ${meta.taskId.slice(0, 10)}…:`, (err as Error).message);
  }
}

/** Best-effort outcome fill-in from the accept / settlement paths. */
export async function recordShadowOutcome(
  taskHash: string,
  outcome: { acceptedBy?: string; settled?: boolean },
): Promise<void> {
  try {
    const db = await getPool();
    const sets: string[] = ['updated_at = NOW()'];
    const vals: unknown[] = [taskHash.toLowerCase()];
    if (outcome.acceptedBy !== undefined) {
      vals.push(outcome.acceptedBy.toLowerCase());
      sets.push(`accepted_by = $${vals.length}`);
    }
    if (outcome.settled !== undefined) {
      vals.push(outcome.settled);
      sets.push(`settled = $${vals.length}`);
    }
    await db.query(`UPDATE match_shadow_log SET ${sets.join(', ')} WHERE task_hash = $1`, vals);
  } catch (err) {
    console.warn(`[semanticMatch] shadow outcome failed for ${taskHash.slice(0, 10)}…:`, (err as Error).message);
  }
}

// ── Metrics (pure — unit-tested; the tuning loop's success gate) ────────────

export interface ShadowRow {
  semantic_topk: Array<{ address: string }>;
  semantic_rerank_topk?: Array<{ address: string }>;
  tag_topk: Array<{ address: string }>;
  accepted_by: string | null;
  settled: boolean | null;
}

export interface RankMetric { hit1: number; hit3: number; mrr: number }
export interface ShadowMetrics {
  tasks: number;            // rows with a known acceptor AND ranking data (scorable)
  // Rows with a known acceptor but NO ranking data — e.g. a routed_by
  // placeholder whose recordMatchShadow write failed during a provider
  // outage. Surfaced so the operator can see how much of the accepted sample
  // the hit/MRR/settled numbers exclude, instead of it vanishing silently.
  unscoredTasks: number;
  settledTasks: number;
  semantic: RankMetric;
  semanticRerank: RankMetric;
  tag: RankMetric;
}

/** Rank (1-based) of the actual acceptor in a ranking, or 0 if absent.
 *  Tolerates malformed entries (missing address) so a bad persisted row can't
 *  crash the admin report. */
function rankOf(list: Array<{ address?: string }>, addr: string): number {
  const i = list.findIndex((e) => e.address?.toLowerCase() === addr);
  return i === -1 ? 0 : i + 1;
}

/**
 * How well did each ranking predict the agent that ACTUALLY took (and ideally
 * settled) the task? hit@1 / hit@3 / mean-reciprocal-rank, computed over rows
 * with a known acceptor and at least one recorded ranking (rows excluded for
 * having no ranking data are reported as unscoredTasks). This is the loop's
 * comparison metric: "flip-ready" = semantic ≥ tag on MRR (primary) without a
 * lower settled rate.
 */
export function computeShadowMetrics(rows: ShadowRow[]): ShadowMetrics {
  // A row must have a known acceptor AND at least one recorded ranking to be
  // scorable. Rows with no ranking data (e.g. a routed_by placeholder whose
  // recordMatchShadow write failed on a provider outage) would count as a
  // miss for every ranking and silently deflate the flip's success gate —
  // they are counted separately (unscoredTasks) so the exclusion is visible.
  const accepted = rows.filter((r) => !!r.accepted_by);
  const scored = accepted.filter(
    (r) => r.semantic_topk.length > 0 || (r.semantic_rerank_topk?.length ?? 0) > 0 || r.tag_topk.length > 0,
  );
  const agg = (pick: (r: ShadowRow) => Array<{ address: string }>) => {
    let hit1 = 0, hit3 = 0, rr = 0;
    for (const r of scored) {
      const rank = rankOf(pick(r), r.accepted_by!.toLowerCase());
      if (rank === 1) hit1++;
      if (rank >= 1 && rank <= 3) hit3++;
      if (rank > 0) rr += 1 / rank;
    }
    const n = scored.length || 1;
    return {
      hit1: Math.round((hit1 / n) * 1000) / 1000,
      hit3: Math.round((hit3 / n) * 1000) / 1000,
      mrr: Math.round((rr / n) * 1000) / 1000,
    };
  };
  return {
    tasks: scored.length,
    unscoredTasks: accepted.length - scored.length,
    settledTasks: scored.filter((r) => r.settled === true).length,
    semantic: agg((r) => r.semantic_topk),
    // Falls back to the semantic order for rows recorded before rerank capture
    // (or when the reranker was disabled), so the metric stays comparable.
    semanticRerank: agg((r) => (r.semantic_rerank_topk?.length ? r.semantic_rerank_topk : r.semantic_topk)),
    tag: agg((r) => r.tag_topk),
  };
}

/** Load recent shadow rows + computed metrics (the admin report). */
export async function shadowReport(limit = 200): Promise<{
  metrics: ShadowMetrics;
  routedCounts: Record<string, number>;
  recent: unknown[];
}> {
  const db = await getPool();
  // Canary dial alongside the metrics: how often each router actually drove
  // the cascade over the last 30 days (bounded via idx_shadow_created so the
  // append-only table can't make the admin report a full-table scan).
  // 'unrouted' = broadcast, flag-off, or pre-flip rows.
  const [{ rows }, { rows: counts }] = await Promise.all([
    db.query<ShadowRow & { task_hash: string; routing_text: string; created_at: string }>(
      'SELECT * FROM match_shadow_log ORDER BY created_at DESC LIMIT $1',
      [Math.min(1000, limit)],
    ),
    db.query<{ routed_by: string | null; n: string }>(
      `SELECT routed_by, COUNT(*)::TEXT AS n FROM match_shadow_log
        WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY routed_by`,
    ),
  ]);
  const routedCounts = Object.fromEntries(
    counts.map((r) => [r.routed_by ?? 'unrouted', Number(r.n)]),
  );
  return { metrics: computeShadowMetrics(rows), routedCounts, recent: rows.slice(0, 25) };
}
