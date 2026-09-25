import { embedMany } from './embeddingService.js';
import { buildTaskRoutingText } from './semanticMatch.js';
import * as deployedAgentStore from './deployedAgentStore.js';
import * as skillStore from './skillStore.js';
import { config } from '../config.js';
import type { A2ATaskMeta, InstalledSkill } from '../types.js';

/**
 * Proof re-key (the semantic era's trust plumbing).
 *
 * Old world: proof — skill_stats rows and auto-'earned' badges — was keyed by
 * the task's declared capability TAGS at settlement. Semantic routing makes
 * tags optional, so semantically routed tasks increasingly settle with no
 * tags at all, and the worker's track record silently stops accruing exactly
 * as the marketplace stops needing tags. This module closes that hole: at
 * settlement, the task's PUBLIC routing text is matched (cosine, one batched
 * embedMany call per settlement) against the worker's installed PUBLIC skills
 * and the closest one above a floor is credited alongside any declared tags.
 *
 * Deliberate v1 bounds:
 * - Slug keys are NAMESPACED ('skill:<slug>') in skill_stats/agent_badges —
 *   author-chosen slugs share a TEXT keyspace with the capability enum, and
 *   four tags (translation, summarization, testing, scheduling) are
 *   themselves valid slugs; without the prefix a stranger's skill named
 *   'testing' would merge into (and poison) the QA tag's proven counts.
 * - Only PUBLIC registry skills participate. skill_stats/badges are readable
 *   unauthenticated, so crediting a private draft skill would leak its slug;
 *   and skill INSTRUCTIONS are author IP (stripped from every /agents
 *   response), so matching uses name + tags only — instructions never leave
 *   the platform through this path.
 * - Top-1 credit only. A task exercising two skills credits the closer one;
 *   credit-all-above-floor risks over-crediting and can be revisited with
 *   real distribution data.
 * - The CURRENT skill loadout is matched, not a task-time snapshot — a skill
 *   installed between accept and settlement can absorb the credit. Accepted
 *   for v1: the work itself was real and paid, only the per-skill attribution
 *   is gameable, and a task-time snapshot needs accept-time state we don't
 *   keep.
 *
 * Cost honesty: the embed memo's 5-min TTL rarely spans settlements, so
 * steady state is ONE batched provider call (task text + ≤10 short skill
 * lines) per settlement, bounded by the 10s fetch timeout. Callers run this
 * fire-and-forget — proof enrichment must never block a payout.
 */

/** Namespace for slug-keyed proof rows, so programmatic consumers (MCP
 *  provenSkills, profile UIs) can tell slug proof from enum-tag proof and the
 *  two keyspaces can never collide. */
export const PROOF_SLUG_PREFIX = 'skill:';

/** The ONE place caps + resolved slug become the proof-ledger key set —
 *  success and dispute paths must credit/debit identical keys or the
 *  earned-badge failure-ratio guard goes blind.
 *  Each key appears once: skillStatsStore upserts once per entry, so a tag
 *  the poster listed five times turned one settlement into five completions
 *  (an instant 'earned' badge) and one failed round into five failures
 *  (security audit run 1, C13). Tasks stored before the index schema
 *  de-duplicated requiredCapabilities still carry repeats. */
export function mergeProofKeys(caps: string[], slug: string | null): string[] {
  const keys = slug ? [...caps, `${PROOF_SLUG_PREFIX}${slug}`] : caps;
  return [...new Set(keys)];
}

/** The text a skill exposes for matching — name + routing tags ONLY.
 *  Instructions are author IP and must not be sent to the embedding
 *  provider from this path. */
export function skillDocText(s: Pick<InstalledSkill, 'name' | 'capabilities'>): string {
  const caps = s.capabilities?.length ? ` (${s.capabilities.join(', ')})` : '';
  return `${s.name}${caps}`;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

/** Pure argmax-with-floor over skill vectors (unit-tested). Returns the slug
 *  of the closest skill iff its cosine clears the threshold, else null —
 *  a task unrelated to everything the agent installed credits nothing. */
export function bestSkillSlug(
  taskVec: number[],
  skills: Array<{ slug: string; vector: number[] }>,
  threshold: number,
): { slug: string; similarity: number } | null {
  let best: { slug: string; similarity: number } | null = null;
  for (const s of skills) {
    const sim = cosine(taskVec, s.vector);
    if (!best || sim > best.similarity) best = { slug: s.slug, similarity: sim };
  }
  return best && best.similarity >= threshold ? best : null;
}

/**
 * Resolve the worker's best-matching PUBLIC installed skill slug for a
 * settled task (UN-prefixed — callers key it via mergeProofKeys), or null
 * when there is nothing to credit: no deployed agent, no public installed
 * skills, no routing text, weak match, or any failure.
 */
export async function resolveProofSkillSlug(
  executorAddr: string,
  meta: Pick<A2ATaskMeta, 'publicBrief' | 'routingSummary' | 'requiredCapabilities'>,
): Promise<string | null> {
  try {
    const agent = await deployedAgentStore.loadAgentByWallet(executorAddr);
    const installed = agent?.skills ?? [];
    if (installed.length === 0) return null;

    const routingText = buildTaskRoutingText(meta);
    if (!routingText) return null;

    // Public-registry skills only: proof rows are publicly readable, so a
    // private draft's slug must never surface through them.
    const pub = await skillStore.listPublicSlugs(installed.map((s) => s.slug));
    const skills = installed.filter((s) => pub.has(s.slug.toLowerCase()));
    if (skills.length === 0) return null;

    // ONE batched provider call for the task text + every skill line — never
    // a per-skill fan-out on the settlement path.
    const { vectors } = await embedMany([routingText, ...skills.map(skillDocText)]);
    const [taskVec, ...skillVecs] = vectors;
    const best = bestSkillSlug(
      taskVec,
      skills.map((s, i) => ({ slug: s.slug, vector: skillVecs[i] })),
      config.proofSlugSimThreshold,
    );
    if (best) {
      console.log(
        `[proof] slug credit: ${executorAddr.slice(0, 10)}… × ${best.slug} (cosine ${best.similarity.toFixed(3)})`,
      );
    }
    return best?.slug ?? null;
  } catch (err) {
    console.warn(`[proof] slug resolution failed for ${executorAddr.slice(0, 10)}…:`, (err as Error).message);
    return null;
  }
}
