/**
 * Rubric Engine — composable, exception-isolated scoring for agent output.
 *
 * Ported from the design of prompt-eval-rubric (Python) to TypeScript.
 * Each rubric is a function (output: string) => number (0.0–1.0).
 * If a rubric throws, it scores 0.0 and the pipeline continues.
 */

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
 * Output must carry every named field: as a key of the JSON object it contains,
 * or — for prose deliverables — as a heading/label ("Summary:", "## Summary",
 * "**Summary**"). Score = fraction of fields present.
 */
export function HasFields(fields: string[]): RubricFn {
  return (output: string) => {
    if (!fields.length) return 1;
    const parsed = extractJsonObject(output);
    const present = fields.filter(f => {
      if (parsed) return f in parsed && parsed[f] != null;
      const label = f.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\s_-]+/g, '[\\s_-]+');
      return new RegExp(
        `(?:^|[.!?]\\s)[ \\t]*(?:#{1,6}[ \\t]*|[-*][ \\t]+)?(?:\\*\\*|__)?${label}(?:\\*\\*|__)?[ \\t]*(?::|$)`,
        'im',
      ).test(output);
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
      const present = schema.required.filter(k => k in obj);
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
 * tests. For full coverage, swap in the `re2` engine.
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

/** Output must match a regex pattern. Score 1.0 if matched, 0.0 otherwise. */
export function MatchesRegex(pattern: RegExp): RubricFn {
  // Bound the input the pattern runs against as defence-in-depth against
  // polynomial backtracking on top of isSafeRegexSource's star-height guard.
  return (output: string) =>
    pattern.test(output.length > REGEX_INPUT_CAP ? output.slice(0, REGEX_INPUT_CAP) : output) ? 1 : 0;
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
