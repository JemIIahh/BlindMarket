/**
 * Rubric Engine — composable, exception-isolated scoring for agent output.
 *
 * Ported from the design of prompt-eval-rubric (Python) to TypeScript.
 * Each rubric is a function (output: string) => number (0.0–1.0).
 * If a rubric throws, it scores 0.0 and the pipeline continues.
 */

import vm from 'node:vm';

// ── Types ────────────────────────────────────────────────────────────────────

export type RubricFn = (output: string) => number;

export interface RubricResult {
  name: string;
  score: number;   // 0.0 – 1.0
  weight: number;  // normalized weight
  reason: string;
  error?: string;  // set if the rubric threw
}

export interface ScoreResult {
  score: number;          // 0.0 – 1.0 (weighted aggregate)
  passed: boolean;        // score >= passThreshold
  breakdown: RubricResult[];
  errors: Record<string, string>;  // rubricName → error message
}

// ── Helper ───────────────────────────────────────────────────────────────────

function safe(fn: RubricFn, name: string, output: string): { score: number; error?: string } {
  try {
    const s = fn(output);
    return { score: Math.min(1, Math.max(0, s)) };
  } catch (e) {
    return { score: 0, error: `${name}: ${(e as Error).message}` };
  }
}

// ── Built-in Rubrics ─────────────────────────────────────────────────────────

/** Output must contain ALL of the given keywords (case-insensitive). */
export function ContainsKeywords(keywords: string[]): RubricFn {
  return (output: string) => {
    if (!keywords.length) return 1;
    const lower = output.toLowerCase();
    const hits = keywords.filter(k => lower.includes(k.toLowerCase()));
    return hits.length / keywords.length;
  };
}

/** Output length (characters) must be between min and max. */
export function LengthBetween(min: number, max: number = Infinity): RubricFn {
  return (output: string) => {
    const len = output.length;
    if (len < min) return Math.min(1, len / min);
    if (len > max) return Math.min(1, max / len);
    return 1;
  };
}

const JSON_SCAN_CAP = 200_000;
const JSON_SCAN_MAX_STARTS = 50; // bounds the balanced-brace scan on brace-heavy non-JSON

/**
 * Pull a JSON object out of agent output. Agents rarely return bare JSON — they
 * wrap it in a ```json fence or lead in with a sentence — so parsing the whole
 * string rejects correct work. Tries, in order: the whole output, each fenced
 * block, then the first balanced {...} that parses. Returns undefined when the
 * output holds no JSON object.
 */
export function extractJsonObject(output: string): Record<string, unknown> | undefined {
  const asObject = (text: string): Record<string, unknown> | undefined => {
    try {
      const parsed: unknown = JSON.parse(text);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : undefined;
    } catch {
      return undefined;
    }
  };

  const src = output.length > JSON_SCAN_CAP ? output.slice(0, JSON_SCAN_CAP) : output;
  const whole = asObject(src.trim());
  if (whole) return whole;

  for (const m of src.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gi)) {
    const fenced = asObject(m[1].trim());
    if (fenced) return fenced;
  }

  // First balanced {...}, string-aware so braces inside values don't end it early.
  let starts = 0;
  for (let start = src.indexOf('{'); start !== -1 && starts < JSON_SCAN_MAX_STARTS; start = src.indexOf('{', start + 1), starts++) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < src.length; i++) {
      const ch = src[i];
      if (inString) {
        if (ch === '\\') i++;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        const candidate = asObject(src.slice(start, i + 1));
        if (candidate) return candidate;
        break;
      }
    }
  }
  return undefined;
}

/**
 * A field counts only when it holds something. `{"summary":""}` and
 * `{"summary":{}}` carry the key and no work; 0 and false are real values.
 */
export function hasContent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

const LABEL_BODY_CHARS = 400; // how far past a prose label to look for its content

/**
 * Output must carry every named field WITH a value: as a non-empty key of the
 * JSON object it contains, or — for prose deliverables — as a heading/label
 * ("Summary:", "## Summary", "**Summary**") followed by content before the next
 * heading. Bare labels ("Summary:\nScore:") are a template, not a deliverable.
 * Score = fraction of fields present.
 */
export function HasFields(fields: string[]): RubricFn {
  const labelSource = (f: string) => f.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\s_-]+/g, '[\\s_-]+');
  const named = fields.filter(f => f.trim().length > 0);
  // A field's content ends where the next field's label starts ("Summary: Score: 5").
  const anyLabel = new RegExp(`(?:${named.map(labelSource).join('|') || '(?!)'})(?:\\*\\*|__)?[ \\t]*:`, 'i');
  return (output: string) => {
    if (!fields.length) return 1;
    const parsed = extractJsonObject(output);
    const src = output.length > JSON_SCAN_CAP ? output.slice(0, JSON_SCAN_CAP) : output;
    const present = fields.filter(f => {
      if (parsed) return f in parsed && hasContent(parsed[f]);
      if (!f.trim()) return false;
      const label = new RegExp(
        `(?:^|[.!?]\\s)[ \\t]*(?:#{1,6}[ \\t]*|[-*][ \\t]+)?(?:\\*\\*|__)?${labelSource(f)}(?:\\*\\*|__)?[ \\t]*(?::|$)`,
        'gim',
      );
      let tries = 0;
      for (let m = label.exec(src); m && tries < 20; m = label.exec(src), tries++) {
        const after = src.slice(m.index + m[0].length, m.index + m[0].length + LABEL_BODY_CHARS);
        const nextHeading = after.search(/\n[ \t]*#{1,6}[ \t]/);
        const section = nextHeading === -1 ? after : after.slice(0, nextHeading);
        const nextLabel = section.search(anyLabel);
        if (/[\p{L}\p{N}]/u.test(nextLabel === -1 ? section : section.slice(0, nextLabel))) return true;
      }
      return false;
    });
    return present.length / fields.length;
  };
}

/**
 * Output must contain a JSON object matching the given schema (basic structural
 * check). The object may be fenced or embedded in prose — see extractJsonObject.
 */
export function JsonSchema(schema: {
  type?: string;
  required?: string[];
  properties?: Record<string, { type?: string }>;
}): RubricFn {
  return (output: string) => {
    let parsed: unknown = extractJsonObject(output);
    if (parsed === undefined) {
      try {
        parsed = JSON.parse(output);
      } catch {
        return 0;
      }
    }
    if (schema.type === 'object' && (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))) {
      return 0;
    }
    if (schema.required && typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      if (!schema.required.length) return 1;
      // Same bar as HasFields: a required key holding "" or {} is not delivered.
      const present = schema.required.filter(k => k in obj && hasContent(obj[k]));
      return present.length / schema.required.length;
    }
    return 1;
  };
}

/**
 * Reject regex sources that risk catastrophic backtracking (ReDoS). Blocks
 * "star height >= 2" — a quantifier (*, +, {n,}) applied to a group that itself
 * contains a quantifier: (a+)+, ((a+))+, (a+|b)+ — the classic exponential
 * blowup, incl. the ^(a+)$ / ^(a+)+$ family. Also caps overall length.
 *
 * This is a heuristic, not an RE2-grade guarantee — it does not model
 * alternation-overlap (e.g. (a|a)+), so MatchesRegex ALSO bounds the input it
 * tests and the time it may take (testRegexBounded).
 */
export function isSafeRegexSource(src: string): boolean {
  if (src.length > 200) return false;
  const groupHasQuant: boolean[] = []; // per currently-open '(' group
  let closedGroupHadQuant = false;     // did the most-recently-closed group hold a quantifier?
  let prevWasGroupClose = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') { i++; prevWasGroupClose = false; continue; } // skip escaped char
    if (ch === '[') { // skip char class — quantifier chars inside are literal
      i++;
      while (i < src.length && src[i] !== ']') { if (src[i] === '\\') i++; i++; }
      prevWasGroupClose = false;
      continue;
    }
    if (ch === '(') { groupHasQuant.push(false); prevWasGroupClose = false; continue; }
    if (ch === ')') {
      const had = groupHasQuant.pop() ?? false;
      closedGroupHadQuant = had;
      if (had && groupHasQuant.length) groupHasQuant[groupHasQuant.length - 1] = true; // propagate up
      prevWasGroupClose = true;
      continue;
    }
    const isQuant = ch === '*' || ch === '+' || (ch === '{' && /^\{\d*,?\d*\}/.test(src.slice(i, i + 12)));
    if (isQuant) {
      if (prevWasGroupClose && closedGroupHadQuant) return false; // nested quantifier -> ReDoS
      if (groupHasQuant.length) groupHasQuant[groupHasQuant.length - 1] = true;
      prevWasGroupClose = false;
      continue;
    }
    prevWasGroupClose = false;
  }
  return true;
}

const REGEX_INPUT_CAP = 20_000;
const REGEX_TIMEOUT_MS = 100;

export class RegexTimeoutError extends Error {
  constructor(source: string) {
    super(`regex timed out after ${REGEX_TIMEOUT_MS}ms: ${source.slice(0, 80)}`);
    this.name = 'RegexTimeoutError';
  }
}

// One reusable context; the script only reads the two slots set per call.
const regexSandbox = vm.createContext(Object.create(null) as { re?: RegExp; input?: string });
const regexScript = new vm.Script('re.test(input)');

/**
 * pattern.test(input) with a wall-clock bound. isSafeRegexSource cannot see
 * alternation overlap — (a|a)+$ and ^(a|b|ab)*c pass it and backtrack
 * exponentially on ~40 characters, and a regex running on the main thread
 * freezes every request. V8 honours the vm timeout inside regex backtracking
 * (executed: both patterns interrupt at ~100ms and the process carries on).
 * Throws RegexTimeoutError; callers deciding payment must fail closed on it.
 */
export function testRegexBounded(pattern: RegExp, input: string, timeoutMs: number = REGEX_TIMEOUT_MS): boolean {
  regexSandbox.re = pattern;
  regexSandbox.input = input.length > REGEX_INPUT_CAP ? input.slice(0, REGEX_INPUT_CAP) : input;
  try {
    return regexScript.runInContext(regexSandbox, { timeout: timeoutMs }) === true;
  } catch (e) {
    if ((e as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw new RegexTimeoutError(pattern.source);
    throw e;
  } finally {
    regexSandbox.re = undefined;
    regexSandbox.input = undefined;
  }
}

/** Output must match a regex pattern. Score 1.0 if matched, 0.0 otherwise; throws on timeout. */
export function MatchesRegex(pattern: RegExp): RubricFn {
  // Bounded in input (REGEX_INPUT_CAP) and in time, on top of
  // isSafeRegexSource's star-height guard.
  return (output: string) => (testRegexBounded(pattern, output) ? 1 : 0);
}

/** Output must NOT contain any of the forbidden phrases. Score 1.0 if clean, 0.0 if any found. */
export function NoForbiddenPhrases(phrases: string[]): RubricFn {
  return (output: string) => {
    if (!phrases.length) return 1;
    const lower = output.toLowerCase();
    const found = phrases.some(p => lower.includes(p.toLowerCase()));
    return found ? 0 : 1;
  };
}

// ── Composable Rubrics ───────────────────────────────────────────────────────

/**
 * Weighted rubric: weighted average across multiple rubrics.
 * Weights are normalized so they don't need to sum to 1.
 */
export class WeightedRubric {
  private rubrics: Array<{ fn: RubricFn; weight: number; name: string }>;

  constructor(rubrics: Array<{ fn: RubricFn; weight: number; name?: string }>) {
    this.rubrics = rubrics.map((r, i) => ({
      fn: r.fn,
      weight: r.weight,
      name: r.name ?? `rubric_${i}`,
    }));
  }

  score(output: string, passThreshold: number = 0.6): ScoreResult {
    const breakdown: RubricResult[] = [];
    const errors: Record<string, string> = {};
    let totalWeight = 0;
    let weightedSum = 0;

    for (const r of this.rubrics) {
      const { score, error } = safe(r.fn, r.name, output);
      if (error) errors[r.name] = error;
      breakdown.push({ name: r.name, score, weight: r.weight, reason: error ? 'CRASHED' : '', error });
      weightedSum += score * r.weight;
      totalWeight += r.weight;
    }

    const finalScore = totalWeight > 0 ? weightedSum / totalWeight : 0;
    return {
      score: Math.round(finalScore * 1000) / 1000,
      passed: finalScore >= passThreshold,
      breakdown,
      errors,
    };
  }
}

/**
 * AllRubric: strict mode — fails if ANY rubric scores below threshold.
 * Useful when every check must pass, not just the weighted average.
 */
export class AllRubric {
  private rubrics: Array<{ fn: RubricFn; name: string }>;
  private threshold: number;

  constructor(rubrics: Array<{ fn: RubricFn; name?: string }>, threshold: number = 0.5) {
    this.rubrics = rubrics.map((r, i) => ({
      fn: r.fn,
      name: r.name ?? `rubric_${i}`,
    }));
    this.threshold = threshold;
  }

  score(output: string): ScoreResult {
    const breakdown: RubricResult[] = [];
    const errors: Record<string, string> = {};
    let allPassed = true;

    for (const r of this.rubrics) {
      const { score, error } = safe(r.fn, r.name, output);
      if (error) errors[r.name] = error;
      const passed = !error && score >= this.threshold;
      if (!passed) allPassed = false;
      breakdown.push({
        name: r.name,
        score,
        weight: 1 / this.rubrics.length,
        reason: error ? 'CRASHED' : passed ? 'PASS' : 'BELOW_THRESHOLD',
        error,
      });
    }

    const avgScore = breakdown.reduce((s, r) => s + r.score, 0) / breakdown.length;
    return {
      score: Math.round(avgScore * 1000) / 1000,
      passed: allPassed,
      breakdown,
      errors,
    };
  }
}
