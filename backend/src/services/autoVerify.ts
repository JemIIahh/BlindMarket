import type { VerificationCriteria } from '../types.js';
import {
  WeightedRubric,
  ContainsKeywords,
  JsonSchema,
  HasFields,
  NoForbiddenPhrases,
  extractJsonObject,
  isSafeRegexSource,
  testRegexBounded,
  RegexTimeoutError,
} from './rubricEngine.js';
import type { RubricResult } from './rubricEngine.js';
import { verificationCriteriaSchema } from './verificationCriteriaSchema.js';

export interface AutoVerifyResult {
  passed: boolean;
  score: number;          // 0-100
  reasons: string[];
  breakdown: RubricResult[];
  errors: Record<string, string>;
}

/**
 * System-level failure language — always applied regardless of poster config.
 * Catches the excuses agents produce when they can't deliver.
 *
 * Two classes, because the SUBJECT of a deliverable can be failure:
 *  - REFUSAL: the worker speaking about itself or the task ("I was unable
 *    to…", "I cannot complete…", "As an AI…", "sorry … can't", "unable to
 *    complete the task"). Outside a disclosure section this is the worker
 *    saying the job was not done.
 *  - NEUTRAL: failure vocabulary with no speaker ("users were unable to
 *    connect", "service unavailable", "status: failed"). An incident report or
 *    an error-handling snippet is made of these.
 *
 * Two layers:
 *  - HARD GATE (fails outright; a weighted rubric can't do this — at weight
 *    0.5 its 0 is outvoted, a bare excuse used to pass at 67):
 *      · a refusal needs MIN_WORDS_BESIDE_REFUSAL words outside every
 *        failure-phrase sentence AND refusal sentences at most
 *        MAX_REFUSAL_SHARE of all words. "Excuse + two lines of filler" used to
 *        clear the old 15-word bar; honest gaps have an exempt place to go
 *        (below), so outside it a refusal must be dwarfed by the work.
 *      · neutral phrases alone fail only when there is next to nothing else:
 *        fewer than MIN_SUBSTANTIVE_WORDS outside them and fewer than
 *        MIN_DISTINCT_WORDS distinct words overall ("Service unavailable.").
 *  - SOFT: any failure phrase in the deliverable costs the 0.5-weight
 *    system_failure_detection rubric.
 *
 * The worker prompt REQUIRES a "Not done / assumptions" section, so that
 * section is split off first (splitDisclosure) and neither layer reads it. The
 * content floor doesn't either — the section is not the deliverable.
 *
 * Every pattern is linear: gaps are bounded and stay inside one sentence. The
 * previous 'a.*b' sources were quadratic on 'status status status…' — 4 s at
 * 100 KB, minutes at the 2 MB result cap, on the request thread.
 */
const GAP = '[^.!?]{0,80}?';

const REFUSAL_PATTERNS: RegExp[] = [
  /\bi(?:'m| am| was| have been|'ve been)? (?:\w+ )?(?:unable|not able) to\b/g,
  /\bi (?:wasn't|was not|am not|'m not|won't be|will not be|haven't been|have not been) able to\b/g,
  /\bi'm not able to\b/g,
  /\bi (?:cannot|can't|can not|couldn't|could not|won't|will not) (?:\w+ )?(?:complete|finish|fulfil|fulfill|deliver|help|assist|do|provide|perform|comply|proceed|continue|access|browse|generate|produce|accomplish)\b/g,
  /\bas an ai\b/g,
  /\bi (?:do not|don't|did not|didn't) have (?:the )?(?:access|ability|tools?|capabilit(?:y|ies)|means|permissions?)\b/g,
  new RegExp(`\\b(?:sorry|apologi[sz]e|apologies|regret|unfortunately)\\b${GAP}(?:\\bunable\\b|\\bcannot\\b|\\bcan't\\b|\\bcan not\\b|\\bcouldn't\\b|\\bcould not\\b|n't able\\b|\\bnot able\\b|\\bnot possible\\b)`, 'g'),
  /\b(?:unable|not able|failed|impossible) to (?:complete|finish|fulfil|fulfill|deliver|do|perform) (?:the|this|your|that) (?:task|request|job|assignment|work)\b/g,
  /\bcan(?:'t|not| not) (?:help|assist) (?:you )?with\b/g,
  /\b(?:outside|beyond|not(?: with)?in|not) my control\b/g,
];

const NEUTRAL_PATTERNS: RegExp[] = [
  /\b(?:unable to|could not|couldn't|failed to) (?:complete|fulfil|fulfill|deliver)\b/g,
  /\b(?:was|were) (?:unable|not able) to\b/g,
  /\bservice (?:unavailable|is currently|appears to be)\b/g,
  /\bexperiencing technical difficulties\b/g,
  new RegExp(`\\bincomplete\\b${GAP}\\btask\\b`, 'g'),
  new RegExp(`\\b(?:task|status)\\b${GAP}\\bincomplete\\b`, 'g'),
  new RegExp(`\\bstatus\\b${GAP}\\bfailed\\b`, 'g'),
];

/**
 * What the platform worker writes when its own LLM call throws. Looked for
 * near the start, not only at index 0 — "Result: Error during LLM execution…"
 * used to pass at 100.
 */
const ERROR_MARKER = /\berror during llm execution\b|\bllm execution (?:failed|error)\b/;
const ERROR_MARKER_WINDOW = 200;

/** Words outside failure-phrase sentences that neutral failure language needs. */
const MIN_SUBSTANTIVE_WORDS = 15;
/** …unless the text is clearly a document anyway (incident report, code). */
const MIN_DISTINCT_WORDS = 25;
/** Words outside failure-phrase sentences that a first-person refusal needs. */
const MIN_WORDS_BESIDE_REFUSAL = 40;
/** Share of all words that refusal sentences may take up. */
const MAX_REFUSAL_SHARE = 0.5;

/**
 * Content floor (visible characters of the deliverable part). Several rubrics
 * pass vacuously on a near-empty string, so "ok" could clear any mix of them.
 * It applies even under a smaller poster min_length — clients have shipped
 * { min_length: 1 }, and the server must not take that as licence to pay for
 * one character. Only a check that pins down a short answer AND actually runs
 * (expected_answer, a usable regex_pattern, required keys/fields) lifts it.
 */
const DEFAULT_MIN_CONTENT_CHARS = 20;

/**
 * Distinct word-like tokens the floor also needs. Length alone counted
 * 'a'.repeat(40), forty dots and twenty emoji as content. Lifted together with
 * the floor: a URL is several tokens, but a bare hash is one and is only
 * payable against an expected_answer / regex_pattern.
 */
const MIN_DISTINCT_TOKENS = 3;

/** Non-keyword words an output needs before keyword presence counts (no real min_length set). */
const MIN_KEYWORD_CONTEXT_WORDS = 30;

/** Failure language is read in the first and last SCAN_WINDOW characters only. */
const SCAN_WINDOW = 64_000;
/** How far either side of a failure phrase its sentence may extend (unpunctuated lists). */
const SPAN_RADIUS = 160;

// CJK has no spaces, so each ideograph/kana is its own token.
const WORD = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu;
const words = (text: string): string[] => text.toLowerCase().match(WORD) ?? [];

/**
 * Canonical text, line structure kept: NFKC (NBSP, full-width, ligatures),
 * straight apostrophes, invisible characters dropped (zero-width, soft hyphen,
 * bidi and other format/control characters, variation selectors), horizontal
 * whitespace runs collapsed. Without it "un<ZWSP>able", "I  was  unable" and
 * 'ok' + 40 zero-width characters all read as something they are not.
 */
function canonical(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/[\p{Cf}\uFE00-\uFE0F]|[^\P{Cc}\s]/gu, '')
    .replace(/[^\S\n]+/g, ' ');
}

/** One line of text: every whitespace run, newlines included, becomes a space. */
const flatten = (text: string): string => text.replace(/\s+/g, ' ').trim();

// Cyrillic/Greek letters that render as Latin ones. Cheap and partial — it
// stops the copy-paste homoglyph trick, not a determined adversary.
const HOMOGLYPHS: Record<string, string> = {
  // Cyrillic a e o p c x y i s j q w h
  '\u0430': 'a', '\u0435': 'e', '\u043e': 'o', '\u0440': 'p', '\u0441': 'c', '\u0445': 'x', '\u0443': 'y',
  '\u0456': 'i', '\u0455': 's', '\u0458': 'j', '\u051b': 'q', '\u051d': 'w', '\u04bb': 'h',
  // Greek alpha omicron iota nu rho epsilon kappa tau upsilon
  '\u03b1': 'a', '\u03bf': 'o', '\u03b9': 'i', '\u03bd': 'v', '\u03c1': 'p',
  '\u03b5': 'e', '\u03ba': 'k', '\u03c4': 't', '\u03c5': 'u',
};
const HOMOGLYPH_CLASS = new RegExp(`[${Object.keys(HOMOGLYPHS).join('')}]`, 'g');

/** Lowercase, accents and look-alike letters folded. */
function foldText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(HOMOGLYPH_CLASS, ch => HOMOGLYPHS[ch]);
}

/** Text as the phrase patterns read it: folded, and bounded to the two ends. */
function foldForScan(flat: string): string {
  const windowed = flat.length > 2 * SCAN_WINDOW
    ? `${flat.slice(0, SCAN_WINDOW)} … ${flat.slice(-SCAN_WINDOW)}`
    : flat;
  return foldText(windowed);
}

/**
 * A poster's phrase and the output as a reader sees them: canonical, one line,
 * folded, whole text. Matching the raw output let "un<ZWSP>able", a soft hyphen,
 * an NBSP or a Cyrillic look-alike slip a forbidden phrase past the check
 * (security audit run 1, C30).
 */
const phraseText = (text: string): string => foldText(flatten(canonical(text)));

// "Not done", "Assumptions", "Not done / assumptions" as a heading, list item,
// numbered item or bold label — followed by ':' or the end of the line, so a
// paragraph that merely starts "Assumptions about growth…" is not a section.
const DISCLOSURE_HEADING =
  /^ ?(#{1,6})? ?(?:[-*+] |\d{1,3}[.)] )?(?:\*\*|__)? ?(?:not done(?: ?(?:\/|&|and|,) ?assumptions)?|assumptions(?: ?(?:\/|&|and|,) ?not done)?)(?: made)? ?(?:\*\*|__)? ?(?::|$)/gim;
const MD_HEADING = /^ ?(#{1,6}) \S/gm;

/**
 * Remove disclosure sections from canonical text. A section runs from its
 * heading to the next markdown heading of the same or a higher level (any
 * heading, for a plain label), or to the end of the text.
 */
function splitDisclosure(text: string): { deliverable: string; disclosed: boolean } {
  let disclosed = false;
  const heading = new RegExp(DISCLOSURE_HEADING.source, DISCLOSURE_HEADING.flags);
  const anyHeading = new RegExp(MD_HEADING.source, MD_HEADING.flags);
  let deliverable = '';
  let pos = 0;
  for (let m = heading.exec(text); m; m = heading.exec(text)) {
    const level = m[1]?.length ?? 6;
    let end = text.length;
    anyHeading.lastIndex = m.index + m[0].length;
    for (let h = anyHeading.exec(text); h; h = anyHeading.exec(text)) {
      if (h[1].length <= level) { end = h.index; break; }
    }
    deliverable += text.slice(pos, m.index);
    pos = end;
    disclosed = true;
    if (end >= text.length) break;
    heading.lastIndex = end;
  }
  return { deliverable: deliverable + text.slice(pos), disclosed };
}

interface FailureLanguage {
  refusal: boolean;
  neutral: boolean;
  totalWords: number;
  distinctWords: number;
  refusalWords: number;      // words in sentences carrying a refusal
  substantiveWords: number;  // words in sentences carrying no failure phrase at all
}

/** Merge [start, end) spans and count the words inside them. */
function wordsInSpans(text: string, spans: Array<[number, number]>): number {
  spans.sort((a, b) => a[0] - b[0]);
  let count = 0;
  let from = -1;
  let to = -1;
  for (const [s, e] of spans) {
    if (s > to) {
      if (to > from) count += words(text.slice(from, to)).length;
      from = s;
      to = e;
    } else if (e > to) {
      to = e;
    }
  }
  if (to > from) count += words(text.slice(from, to)).length;
  return count;
}

/** The sentence around a phrase hit, at most SPAN_RADIUS either side. */
function sentenceSpan(text: string, start: number, end: number): [number, number] {
  let s = start;
  const minS = Math.max(0, start - SPAN_RADIUS);
  while (s > minS && !(text[s - 1] === ' ' && s >= 2 && '.!?'.includes(text[s - 2]))) s--;
  let e = end;
  const maxE = Math.min(text.length, end + SPAN_RADIUS);
  while (e < maxE && !'.!?'.includes(text[e - 1] ?? '')) e++;
  return [s, e];
}

function scanFailureLanguage(scanText: string): FailureLanguage {
  const collect = (patterns: RegExp[]): Array<[number, number]> => {
    const spans: Array<[number, number]> = [];
    for (const source of patterns) {
      const pattern = new RegExp(source.source, source.flags);
      for (let m = pattern.exec(scanText); m; m = pattern.exec(scanText)) {
        const span = sentenceSpan(scanText, m.index, m.index + m[0].length);
        spans.push(span);
        // The rest of this sentence is already counted; skipping it keeps the
        // span list proportional to the text on 'sorry sorry sorry…'.
        pattern.lastIndex = Math.max(pattern.lastIndex, span[1]);
      }
    }
    return spans;
  };
  const refusalSpans = collect(REFUSAL_PATTERNS);
  const neutralSpans = collect(NEUTRAL_PATTERNS);
  const all = words(scanText);
  const refusalWords = wordsInSpans(scanText, refusalSpans.slice());
  const failureWords = wordsInSpans(scanText, [...refusalSpans, ...neutralSpans]);
  return {
    refusal: refusalSpans.length > 0,
    neutral: neutralSpans.length > 0,
    totalWords: all.length,
    distinctWords: new Set(all).size,
    refusalWords,
    substantiveWords: all.length - failureWords,
  };
}

// Words that dress a short answer without being a competing answer.
const ANSWER_DRESSING = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'it', 'its', "it's", 'this', 'that', 'of', 'to', 'in', 'for', 'and', 'so',
  'answer', 'result', 'final', 'correct', 'output', 'value', 'equals', 'equal', 'therefore', 'thus', 'hence',
]);
const SHORT_EXPECTED_TOKENS = 3;
const MIN_EXPECTED_SHARE = 1 / 3;
const OPPOSITES: Record<string, string[]> = {
  yes: ['no'], no: ['yes'], true: ['false'], false: ['true'],
};

// Answer tokens keep a number whole ("12.5", "1,234.56"). WORD splits it at the
// separator, so "13.5" used to half-match an expected "12.5".
const ANSWER_WORD = new RegExp(`\\p{N}+(?:[.,]\\p{N}+)+(?![\\p{L}\\p{N}])|${WORD.source}`, 'gu');
const answerWords = (text: string): string[] => text.toLowerCase().match(ANSWER_WORD) ?? [];
const isNumberToken = (w: string): boolean => /^\p{N}+(?:[.,]\p{N}+)*$/u.test(w);

/**
 * expected_answer match on word tokens, so "Paris.", "**Paris**" and "The
 * answer is 42." match 'Paris' / '42'. Containing the answer is not enough for
 * a SHORT expected answer — "yes no 42 41 43 true false maybe" contains '42'.
 * Rule: no competing answer of the same kind (another number beside an
 * expected number, the opposite of an expected yes/no/true/false), and the
 * expected tokens make up at least a third of the output once dressing words
 * are set aside. Long expected answers keep the plain overlap score.
 */
function scoreExpectedAnswer(expectedRaw: string, flatOutput: string, note: (text: string) => void): number {
  const expected = answerWords(flatten(canonical(expectedRaw)));
  if (!expected.length) {
    // Nothing word-like to compare ("->", "∅"): literal containment.
    return flatOutput.includes(flatten(canonical(expectedRaw))) ? 1 : 0;
  }
  const actualSet = new Set(answerWords(flatOutput));
  const overlap = expected.filter(w => actualSet.has(w)).length / expected.length;
  if (expected.length > SHORT_EXPECTED_TOKENS) return overlap;
  // A short answer is right or wrong: "George Bush" is not half of "George
  // Washington".
  if (overlap < 1) {
    if (overlap > 0) note('only part of the expected answer is present');
    return 0;
  }

  const expectedSet = new Set(expected);
  const others = [...actualSet].filter(w => !expectedSet.has(w) && !ANSWER_DRESSING.has(w));
  const expectsNumber = expected.some(isNumberToken);
  const competing = others.filter(w =>
    (expectsNumber && isNumberToken(w)) || expected.some(e => OPPOSITES[e]?.includes(w)));
  if (competing.length) {
    note(`output also offers "${competing[0]}" — more than one answer`);
    return 0;
  }
  if (expectedSet.size / (expectedSet.size + others.length) < MIN_EXPECTED_SHARE) {
    note(`expected answer is present but buried among ${others.length} other words`);
    return 0;
  }
  return 1;
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
 * Returns a 0-100 score. Task passes if score >= pass_threshold (default 60)
 * AND every absolute poster requirement is met in full: required_fields,
 * contains_keywords, forbidden_phrases, regex_pattern, expected_schema, and a
 * short expected_answer.
 */
export function autoVerify(
  resultData: Record<string, unknown>,
  criteria: VerificationCriteria,
): AutoVerifyResult {
  // Extract the output string (agent's text response) or stringify the whole object
  const output = typeof resultData.output === 'string'
    ? resultData.output
    : JSON.stringify(resultData);

  // Criteria past the size limits (stored before they existed, or written
  // around the routes) are refused rather than run: their cost grows with the
  // number of fields and this runs on the request thread.
  if (!verificationCriteriaSchema.safeParse(criteria).success) {
    return hardFail('Verification criteria exceed the supported size — cannot auto-verify against them');
  }

  // Empty deliverable is a hard fail before any rubric runs. Several rubrics
  // pass vacuously on an empty string (forbidden phrases, max_length), so a
  // rubric mix could otherwise score an empty output above threshold and
  // release escrow for zero content.
  if (output.trim().length === 0) {
    return hardFail('Empty output');
  }

  // The deliverable as a reader sees it: canonical text, minus the disclosure
  // section the worker prompt requires. The floor and the excuse gate judge
  // this; the rubrics below still read the raw output.
  const { deliverable, disclosed } = splitDisclosure(canonical(output));
  const visible = flatten(deliverable);
  const scanText = foldForScan(visible);

  // Worker error markers are machine-generated failure admissions, not work
  // ("Error during LLM execution: ..." is what the platform worker submits
  // when its own LLM call throws). A weighted rubric averages them into a
  // pass — long enough for min_length, no listed forbidden phrase — and
  // releases escrow for zero content, which is exactly what happened live.
  // Fail closed before any rubric runs. A separate rubric entry would NOT do:
  // its 0 would be outvoted by the passing rubrics.
  if (ERROR_MARKER.test(scanText.slice(0, ERROR_MARKER_WINDOW))) {
    return hardFail('Worker reported an LLM execution error instead of output');
  }

  // A poster check that cannot run must never turn into a payment. Skipping an
  // unsafe or uncompilable regex_pattern used to leave the floor lifted with no
  // rubric behind it: { regex_pattern: '([' } paid for "x" at 100. The match
  // runs here, time-bounded, because a timeout has to fail the whole
  // verification — as a rubric its 0 could be outvoted.
  let regexMatched: boolean | undefined;
  if (criteria.regex_pattern) {
    if (!isSafeRegexSource(criteria.regex_pattern)) {
      return hardFail('regex_pattern was not applied (nested quantifiers or too long) — cannot auto-verify against it');
    }
    try {
      regexMatched = testRegexBounded(new RegExp(criteria.regex_pattern), output);
    } catch (e) {
      return hardFail(e instanceof RegexTimeoutError
        ? 'regex_pattern timed out on this output — cannot auto-verify against it'
        : 'regex_pattern is not a valid regular expression — cannot auto-verify against it');
    }
  }

  // Content floor. min_length is a floor, not a score component: averaged in
  // as a rubric, { min_length: 40 } alone let 16 characters through (0.4 + the
  // system rubric clears 60).
  const expectsShortAnswer = Boolean(
    criteria.expected_answer?.trim()
    || regexMatched !== undefined
    || criteria.expected_schema?.required?.some(k => k.trim())
    || criteria.required_fields?.some(f => f.trim()),
  );
  const minContent = Math.max(criteria.min_length ?? 0, expectsShortAnswer ? 0 : DEFAULT_MIN_CONTENT_CHARS);
  if (visible.length < minContent) {
    return hardFail(disclosed
      ? `Output too short: ${visible.length} characters outside the "Not done / assumptions" section, minimum ${minContent}`
      : `Output too short: ${visible.length} characters, minimum ${minContent}`);
  }
  if (!expectsShortAnswer) {
    const distinct = new Set(words(visible.slice(0, SCAN_WINDOW))).size;
    if (distinct < MIN_DISTINCT_TOKENS) {
      return hardFail(`Output has no real content: ${distinct} distinct words, minimum ${MIN_DISTINCT_TOKENS}`);
    }
  }

  // A refusal, or nothing but failure vocabulary — see REFUSAL_PATTERNS.
  const { refusal, neutral, substantiveWords, refusalWords, totalWords, distinctWords } = scanFailureLanguage(scanText);
  if (refusal && (substantiveWords < MIN_WORDS_BESIDE_REFUSAL || refusalWords > MAX_REFUSAL_SHARE * totalWords)) {
    return hardFail('Output is a failure excuse, not a deliverable');
  }
  if (neutral && substantiveWords < MIN_SUBSTANTIVE_WORDS && distinctWords < MIN_DISTINCT_WORDS) {
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
  const forbidden = (criteria.forbidden_phrases ?? []).map(phraseText).filter(Boolean);
  if (forbidden.length) {
    const noForbidden = NoForbiddenPhrases(forbidden);
    rubrics.push({
      name: 'forbidden_phrases',
      weight: 2,
      fn: (out: string) => noForbidden(phraseText(out)),
    });
  }

  // Regex pattern — already run (time-bounded) above.
  if (regexMatched !== undefined) {
    const matched = regexMatched;
    rubrics.push({ name: 'regex_pattern', weight: 1.5, fn: () => (matched ? 1 : 0) });
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

  // Expected answer — see scoreExpectedAnswer. Judged on the deliverable part.
  if (criteria.expected_answer?.trim()) {
    const expected = criteria.expected_answer;
    rubrics.push({
      name: 'expected_answer',
      weight: 1.5,
      fn: () => scoreExpectedAnswer(expected, visible, (text) => { notes.expected_answer = text; }),
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
    fn: () => (refusal || neutral ? 0 : 1),
  });

  // ── Score ────────────────────────────────────────────────────────────────
  const threshold = (criteria.pass_threshold ?? 60) / 100;
  const rubric = new WeightedRubric(rubrics);
  const result = rubric.score(output, threshold);

  // What the poster states as a requirement is a gate, not a weight. Averaged
  // in, a missing required keyword or a present forbidden phrase was outvoted
  // by rubrics any non-refusal earns, and the escrow paid out (security audit
  // run 1, C11). The score stays, so clients can still explain the verdict.
  const shortExpected = Boolean(criteria.expected_answer?.trim())
    && answerWords(flatten(canonical(criteria.expected_answer!))).length <= SHORT_EXPECTED_TOKENS;
  const GATED = new Set([
    'required_fields', 'contains_keywords', 'forbidden_phrases', 'regex_pattern', 'expected_schema',
    ...(shortExpected ? ['expected_answer'] : []),
  ]);
  const gateMissed = result.breakdown.some(r => GATED.has(r.name) && (r.error || r.score < 1));
  const passed = result.passed && !gateMissed;

  const reasons = result.breakdown
    .filter(r => r.error || r.score < 0.5 || (GATED.has(r.name) && r.score < 1))
    .map(r => r.error
      ? `[CRASHED] ${r.error}`
      : `${r.name}: ${notes[r.name] ?? `${(r.score * 100).toFixed(0)}%`}`);

  if (passed) reasons.unshift('All verification criteria met');

  return {
    passed,
    score: Math.round(result.score * 100),
    reasons,
    breakdown: result.breakdown,
    errors: result.errors,
  };
}
