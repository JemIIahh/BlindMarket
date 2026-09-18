import type { VerificationCriteria } from '../types.js';
import {
  WeightedRubric,
  ContainsKeywords,
  LengthBetween,
  JsonSchema,
  HasFields,
  MatchesRegex,
  NoForbiddenPhrases,
  extractJsonObject,
  isSafeRegexSource,
} from './rubricEngine.js';
import type { RubricResult } from './rubricEngine.js';

export interface AutoVerifyResult {
  passed: boolean;
  score: number;          // 0-100
  reasons: string[];
  breakdown: RubricResult[];
  errors: Record<string, string>;
}

/**
 * System-level forbidden phrases — always applied regardless of poster config.
 * Catches common failure excuses that agents produce when they can't deliver.
 * Entries are regex sources (hence 'sorry.*unable'), matched case-insensitively
 * one sentence at a time.
 *
 * Two layers:
 *  - HARD GATE: a failure phrase is present AND the output is predominantly
 *    excuse — the sentences that don't carry a failure phrase hold fewer than
 *    MIN_SUBSTANTIVE_WORDS words, OR the excuse sentences make up more than
 *    MAX_EXCUSE_SHARE of all words. That is an excuse, not a deliverable, and
 *    it fails outright. A weighted rubric can't do this: at weight 0.5 its 0 is
 *    outvoted (a bare excuse used to pass at 67, and repeating it cleared
 *    min_length too).
 *  - SOFT: a real deliverable that also says what it couldn't do clears the
 *    gate and only loses the 0.5-weight system_failure_detection rubric. The
 *    worker prompt REQUIRES a "Not done / assumptions" section, so honest
 *    disclosure next to real work must never hard-fail.
 */
const DEFAULT_FORBIDDEN_PHRASES = [
  'unable to complete',
  'could not complete',
  "couldn't complete",
  'was unable to',
  'was not able to',
  'could not fulfill',
  "couldn't fulfill",
  'service unavailable',
  'service is currently',
  'service appears to be',
  'experiencing technical difficulties',
  'outside my control',
  'not my control',
  'beyond my control',
  'apologize.*unable',
  'sorry.*unable',
  'regret.*unable',
  'failed to deliver',
  'unable to deliver',
  'could not deliver',
  "couldn't deliver",
  'incomplete.*task',
  'task.*incomplete',
  'status.*incomplete',
  'status.*failed',
];

const FAILURE_PATTERNS = DEFAULT_FORBIDDEN_PHRASES.map(p => new RegExp(p, 'i'));

/** Words of real content a failure-phrase-bearing output needs besides the excuse itself. */
const MIN_SUBSTANTIVE_WORDS = 15;

/** Share of all words that excuse sentences may take up before the output counts as an excuse. */
const MAX_EXCUSE_SHARE = 0.6;

/**
 * Content floor (trimmed characters). Several rubrics pass vacuously on a
 * near-empty string, so "ok" could clear any mix of them. It applies even
 * under a smaller poster min_length — rental clients ship { min_length: 1 },
 * and the server must not take that as licence to pay for one character. Only
 * criteria that pin down a short answer (expected_answer, regex_pattern,
 * expected_schema, required_fields) lift it.
 */
const DEFAULT_MIN_CONTENT_CHARS = 20;

/** Non-keyword words an output needs before keyword presence counts (no real min_length set). */
const MIN_KEYWORD_CONTEXT_WORDS = 30;

const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? [];

/** Sentences carrying a failure phrase, and the word count of everything else. */
function scanFailureLanguage(output: string): { found: boolean; substantiveWords: number; excuseWords: number } {
  // Curly apostrophes would slip "couldn’t complete" past the phrase list.
  const sentences = output.replace(/[\u2018\u2019]/g, "'").split(/(?<=[.!?])\s+|\n+/);
  let found = false;
  let substantiveWords = 0;
  let excuseWords = 0;
  for (const sentence of sentences) {
    if (FAILURE_PATTERNS.some(p => p.test(sentence))) {
      found = true;
      excuseWords += words(sentence).length;
    } else {
      substantiveWords += words(sentence).length;
    }
  }
  return { found, substantiveWords, excuseWords };
}

const hardFail = (reason: string): AutoVerifyResult =>
  ({ passed: false, score: 0, reasons: [reason], breakdown: [], errors: {} });

/**
 * Verify agent output against task criteria.
 *
 * Backward-compatible: old { required_fields, min_length, contains_keywords }
 * criteria still work — they feed into the rubric engine as weighted checks.
 * New fields (max_length, forbidden_phrases, regex_pattern, expected_schema,
 * rubric items) add richer scoring dimensions.
 *
 * Returns a 0-100 score. Task passes if score >= pass_threshold (default 60).
 */
export function autoVerify(
  resultData: Record<string, unknown>,
  criteria: VerificationCriteria,
): AutoVerifyResult {
  // Extract the output string (agent's text response) or stringify the whole object
  const output = typeof resultData.output === 'string'
    ? resultData.output
    : JSON.stringify(resultData);

  // Empty deliverable is a hard fail before any rubric runs. Several rubrics
  // pass vacuously on an empty string (forbidden phrases, max_length), so a
  // rubric mix could otherwise score an empty output above threshold and
  // release escrow for zero content.
  if (output.trim().length === 0) {
    return hardFail('Empty output');
  }

  // Worker error markers are machine-generated failure admissions, not work
  // ("Error during LLM execution: ..." is what the platform worker submits
  // when its own LLM call throws). A weighted rubric averages them into a
  // pass — long enough for min_length, no listed forbidden phrase — and
  // releases escrow for zero content, which is exactly what happened live.
  // Fail closed before any rubric runs. A separate rubric entry would NOT do:
  // its 0 would be outvoted by the passing rubrics.
  if (/^\s*error during llm execution:/i.test(output)) {
    return hardFail('Worker reported an LLM execution error instead of output');
  }

  // Content floor. min_length is a floor, not a score component: averaged in
  // as a rubric, { min_length: 40 } alone let 16 characters through (0.4 + the
  // system rubric clears 60).
  const contentLength = output.trim().length;
  const expectsShortAnswer = Boolean(
    criteria.expected_answer || criteria.regex_pattern || criteria.expected_schema || criteria.required_fields?.length,
  );
  const minContent = Math.max(criteria.min_length ?? 0, expectsShortAnswer ? 0 : DEFAULT_MIN_CONTENT_CHARS);
  if (contentLength < minContent) {
    return hardFail(`Output too short: ${contentLength} characters, minimum ${minContent}`);
  }

  // Predominantly a failure excuse — see DEFAULT_FORBIDDEN_PHRASES.
  const failureLanguage = scanFailureLanguage(output);
  const { substantiveWords, excuseWords } = failureLanguage;
  if (failureLanguage.found && (
    substantiveWords < MIN_SUBSTANTIVE_WORDS
    || excuseWords > MAX_EXCUSE_SHARE * (substantiveWords + excuseWords)
  )) {
    return hardFail('Output is a failure excuse, not a deliverable');
  }

  const rubrics: Array<{ fn: (output: string) => number; weight: number; name: string }> = [];
  // Human-readable reasons for rubrics whose bare percentage explains nothing.
  const notes: Record<string, string> = {};

  // ── Legacy checks (backward-compatible) ──────────────────────────────────

  // Required fields: score = fraction of fields present — as keys of the JSON
  // object in the output, or as headings/labels when the deliverable is prose.
  if (criteria.required_fields?.length) {
    rubrics.push({
      name: 'required_fields',
      weight: 2,
      fn: HasFields(criteria.required_fields),
    });
  }

  // Min length
  if (criteria.min_length) {
    rubrics.push({
      name: 'min_length',
      weight: 1,
      fn: LengthBetween(criteria.min_length),
    });
  }

  // Contains keywords — only counts inside real content. Echoing the keywords
  // back ('revenue churn') used to score 100. Without a real poster min_length
  // (at least the default floor) the output needs MIN_KEYWORD_CONTEXT_WORDS
  // words that aren't the keywords themselves; with one, the poster's own
  // floor (enforced above) governs.
  if (criteria.contains_keywords?.length) {
    const keywordWords = new Set(criteria.contains_keywords.flatMap(k => words(k)));
    const hasKeywords = ContainsKeywords(criteria.contains_keywords);
    rubrics.push({
      name: 'contains_keywords',
      weight: 1.5,
      fn: (out: string) => {
        if ((criteria.min_length ?? 0) < DEFAULT_MIN_CONTENT_CHARS) {
          const context = words(out).filter(w => !keywordWords.has(w)).length;
          if (context < MIN_KEYWORD_CONTEXT_WORDS) {
            notes.contains_keywords = `only ${context} words besides the keywords (need ${MIN_KEYWORD_CONTEXT_WORDS})`;
            return 0;
          }
        }
        return hasKeywords(out);
      },
    });
  }

  // ── New rubric fields ────────────────────────────────────────────────────

  // Max length (reject padding)
  if (criteria.max_length) {
    rubrics.push({
      name: 'max_length',
      weight: 0.5,
      fn: (out: string) => {
        const ratio = out.length / criteria.max_length!;
        return ratio <= 1 ? 1 : Math.max(0, 1 - (ratio - 1));
      },
    });
  }

  // Forbidden phrases — poster's custom list
  if (criteria.forbidden_phrases?.length) {
    rubrics.push({
      name: 'forbidden_phrases',
      weight: 2,
      fn: NoForbiddenPhrases(criteria.forbidden_phrases),
    });
  }

  // Regex pattern — reject ReDoS-prone patterns (star height >= 2) before
  // compiling, so a malicious verification criterion can't freeze the backend.
  if (criteria.regex_pattern) {
    if (!isSafeRegexSource(criteria.regex_pattern)) {
      console.warn('[autoVerify] Skipped unsafe/complex regex_pattern (ReDoS guard):', criteria.regex_pattern.slice(0, 80));
    } else {
      try {
        rubrics.push({
          name: 'regex_pattern',
          weight: 1.5,
          fn: MatchesRegex(new RegExp(criteria.regex_pattern)),
        });
      } catch { /* invalid regex — skip */ }
    }
  }

  // Expected schema — needs JSON (bare, fenced, or embedded); prose scores 0
  // with a reason that says why.
  if (criteria.expected_schema) {
    const matchesSchema = JsonSchema(criteria.expected_schema);
    rubrics.push({
      name: 'expected_schema',
      weight: 2,
      fn: (out: string) => {
        const score = matchesSchema(out);
        if (score === 0 && extractJsonObject(out) === undefined) notes.expected_schema = 'output is not JSON';
        return score;
      },
    });
  }

  // Expected answer (fuzzy: keyword overlap)
  if (criteria.expected_answer) {
    rubrics.push({
      name: 'expected_answer',
      weight: 1.5,
      fn: (out: string) => {
        const expected = criteria.expected_answer!.toLowerCase().split(/\s+/);
        const actual = out.toLowerCase().split(/\s+/);
        const actualSet = new Set(actual);
        const hits = expected.filter(w => actualSet.has(w));
        return hits.length / expected.length;
      },
    });
  }

  // Custom rubric items
  if (criteria.rubric?.length) {
    for (const item of criteria.rubric) {
      rubrics.push({
        name: `rubric_${item.criterion}`,
        weight: item.weight ?? 1,
        fn: (out: string) => {
          if (!item.keywords?.length) return 0.5; // no-op rubric
          const lower = out.toLowerCase();
          const hits = item.keywords.filter(k => lower.includes(k.toLowerCase()));
          const minMentions = item.min_mentions ?? 1;
          return Math.min(1, hits.length / Math.max(1, minMentions));
        },
      });
    }
  }

  // ── Fallback: if no poster criteria at all, just check output exists ─────
  // Must be decided BEFORE the unconditional system rubric is added — an
  // always-present rubric would otherwise disable this guard, and an EMPTY
  // output would pass (it contains no failure phrases) and release payment.
  if (rubrics.length === 0) {
    rubrics.push({
      name: 'basic_output',
      weight: 1,
      fn: (out: string) => out.length > 0 ? 1 : 0,
    });
  }

  // System-level forbidden phrases — always applied, catches failure excuses
  rubrics.push({
    name: 'system_failure_detection',
    weight: 0.5,
    fn: () => failureLanguage.found ? 0 : 1,
  });

  // ── Score ────────────────────────────────────────────────────────────────
  const threshold = (criteria.pass_threshold ?? 60) / 100;
  const rubric = new WeightedRubric(rubrics);
  const result = rubric.score(output, threshold);

  const reasons = result.breakdown
    .filter(r => r.error || r.score < 0.5)
    .map(r => r.error
      ? `[CRASHED] ${r.error}`
      : `${r.name}: ${notes[r.name] ?? `${(r.score * 100).toFixed(0)}%`}`);

  if (result.passed) reasons.unshift('All verification criteria met');

  return {
    passed: result.passed,
    score: Math.round(result.score * 100),
    reasons,
    breakdown: result.breakdown,
    errors: result.errors,
  };
}
