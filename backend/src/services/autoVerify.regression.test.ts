import { describe, it, expect } from 'vitest';
import { autoVerify } from './autoVerify.js';
import type { VerificationCriteria } from '../types.js';

/**
 * Regression table for auto-verification. Every row is a case that was
 * EXECUTED against a previous autoVerify and produced the wrong verdict (or a
 * legitimate neighbour that must keep its verdict). Auto-verify releases
 * escrow, so a row flipping is a payment bug — add rows, don't loosen them.
 */

const EXCUSE = 'I was unable to complete this task because the service was unavailable.';

const LEGIT_REPORT = [
  'Quarterly revenue grew 12% to $4.2M, driven mostly by the enterprise tier.',
  'Churn fell from 3.1% to 2.4% after the onboarding changes shipped in May.',
  'The billing export was unable to reach the legacy warehouse for two days, so those rows were backfilled from the ledger instead.',
  'Recommendation: keep the onboarding flow, retire the legacy warehouse, and revisit enterprise pricing next quarter.',
].join(' ');

// The worker system prompt requires a "Not done / assumptions" section.
const HONEST_REPORT =
  '## Result\nRevenue grew nine percent quarter on quarter, driven by enterprise renewals, while churn held flat at two percent. Gross margin improved by one point as hosting costs fell.\n\n## Not done / assumptions\nI was unable to fetch the live pricing page with my tools, so competitor prices are taken from the brief and may be out of date.';

const PROSE_WITH_LABEL =
  'Summary: The contract compiles cleanly and all twelve unit tests pass. The only finding is an unchecked return value in the withdraw path, which should be wrapped in a require before this ships to mainnet.';

const PROSE_NO_LABEL =
  'The contract compiles cleanly and all twelve unit tests pass. The only finding is an unchecked return value in the withdraw path, which should be wrapped in a require before this ships to the mainnet chain.';

const FENCED_JSON =
  'Here is the result you asked for:\n```json\n{"summary": "All twelve unit tests pass; one unchecked return value in withdraw."}\n```\nLet me know if you need anything else.';

// The "Use now" rental default sent by UseServiceModal / UseFromAgentModal / mcp rent.ts.
const RENTAL: VerificationCriteria = { min_length: 20 };

const PARIS_WITH_DISCLOSURE =
  'Answer: Paris is the capital of France.\n\nNot done / assumptions: I was unable to verify the population figure, so it is omitted from this answer entirely.';

const EXCUSE_PLUS_FILLER =
  'I was unable to complete the task. the quick brown fox jumps over the lazy dog and then runs across the wide green field again today.';

const LONG_WITH_FIRST_PERSON_GAP = [
  'The audit covered all four contracts in the repository and every external entry point was traced by hand.',
  'Reentrancy is not possible in withdraw because balances are zeroed before the transfer, and the pull-payment pattern is used throughout.',
  'I was unable to find a published ABI for the price oracle, so I used the interface declared in IOracle.sol instead.',
  'Two medium findings remain: the fee setter lacks an upper bound and the pause role is never revoked from the deployer.',
  'Both are fixed in the attached patch, and the full test suite passes against the patched build with coverage at ninety-four percent.',
].join(' ');

// The SUBJECT is failures; nobody is refusing anything.
const INCIDENT_REPORT = [
  'At 09:14 UTC the API gateway was unable to connect to the primary database and returned 503 service unavailable to all callers.',
  'Users were unable to connect for eleven minutes while the pool was exhausted and the service unavailable page was shown.',
  'The first fix attempt did not hold: the deploy failed at the migration step and clients were still unable to connect.',
  'The second deploy failed as well because the health check saw service unavailable from the replica during promotion.',
  'Status: the rollback at 09:41 restored traffic; the deploy failed twice because of a missing index, which is now added.',
].join('\n');

const CODE_SNIPPET = [
  'Here is the retry wrapper you asked for:',
  '```ts',
  'export async function fetchWithRetry(url: string, attempts = 3): Promise<Response> {',
  '  let lastStatus = 0;',
  '  for (let i = 0; i < attempts; i++) {',
  '    const res = await fetch(url);',
  '    if (res.ok) return res;',
  '    lastStatus = res.status;',
  '    await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** i));',
  '  }',
  '  throw new Error("unable to complete request: service unavailable");',
  '}',
  '```',
  'It backs off exponentially and surfaces the last failure to the caller.',
].join('\n');

const FILLER = ' The remaining paragraphs of this message are here only to take up space and look like a body of text.';
const ZW = '\u200b';
const URL_ANSWER = 'https://example.com/r/q3.pdf'; // 28 chars
const HASH_ANSWER = '9f86d081884c7fa2a6f5a1b8c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f50';

interface Row {
  name: string;
  output: string;
  criteria: VerificationCriteria;
  pass: boolean;
}

const TABLE: Row[] = [
  // 1. Failure excuses
  { name: 'bare excuse, no criteria', output: EXCUSE, criteria: {}, pass: false },
  { name: 'excuse repeated past min_length', output: Array(4).fill(EXCUSE).join(' '), criteria: { min_length: 100 }, pass: false },
  { name: 'regex-style excuse phrase (sorry.*unable)', output: 'Sorry, I am unable to help with this one right now.', criteria: {}, pass: false },
  { name: 'curly-apostrophe excuse', output: 'I couldn’t complete the request, the upstream API kept timing out.', criteria: {}, pass: false },
  { name: 'long report mentioning "was unable to" in passing', output: LEGIT_REPORT, criteria: { min_length: 100 }, pass: true },
  { name: 'real work plus an honest "Not done" section', output: HONEST_REPORT, criteria: { min_length: 100 }, pass: true },
  { name: '"Not done" section with no work', output: '## Not done / assumptions\nI was unable to complete the task.', criteria: {}, pass: false },
  { name: 'excuse with a cause but no deliverable', output: 'I was unable to complete this task: the brief links to a page that returns 404.', criteria: { min_length: 40 }, pass: false },

  // 2. Keyword echo + content floor
  { name: 'keyword echo', output: 'revenue churn', criteria: { contains_keywords: ['revenue', 'churn'] }, pass: false },
  { name: 'keyword echo padded to the floor', output: 'revenue churn revenue churn revenue churn', criteria: { contains_keywords: ['revenue', 'churn'] }, pass: false },
  { name: 'keywords inside real content', output: LEGIT_REPORT, criteria: { contains_keywords: ['revenue', 'churn'] }, pass: true },
  { name: 'near-empty output, no criteria', output: 'ok', criteria: {}, pass: false },
  { name: 'near-empty output vs vacuous rubric mix', output: 'ok', criteria: { max_length: 500, forbidden_phrases: ['error'] }, pass: false },
  { name: 'short but real answer, no criteria', output: 'Order #12345 confirmed for 2026-05-28', criteria: {}, pass: true },

  // Clients still ship { min_length: 1 } — the floor must hold under it
  { name: 'min_length:1 does not license one character', output: 'x', criteria: { min_length: 1 }, pass: false },
  { name: 'min_length:1 with a real sentence', output: 'The capital of France is Paris, which sits on the river Seine.', criteria: { min_length: 1 }, pass: true },
  { name: 'min_length:1 keyword echo', output: 'revenue churn revenue churn', criteria: { min_length: 1, contains_keywords: ['revenue', 'churn'] }, pass: false },
  { name: 'expected_answer lifts the floor for a short answer', output: '42', criteria: { expected_answer: '42' }, pass: true },
  { name: 'wrong short answer still fails', output: '41', criteria: { expected_answer: '42' }, pass: false },

  // 3. required_fields / expected_schema on non-JSON output
  { name: 'labelled prose satisfies required_fields', output: PROSE_WITH_LABEL, criteria: { required_fields: ['summary'], min_length: 100 }, pass: true },
  { name: 'markdown heading satisfies required_fields', output: `## Summary\n\n${PROSE_NO_LABEL}`, criteria: { required_fields: ['summary'], min_length: 100 }, pass: true },
  { name: 'fenced JSON satisfies required_fields', output: FENCED_JSON, criteria: { required_fields: ['summary'], min_length: 100 }, pass: true },
  { name: 'fenced JSON satisfies expected_schema', output: FENCED_JSON, criteria: { expected_schema: { type: 'object', required: ['summary'] } }, pass: true },
  { name: 'unlabelled prose still misses required_fields', output: PROSE_NO_LABEL, criteria: { required_fields: ['summary'], min_length: 100 }, pass: false },
  { name: 'prose fails expected_schema', output: PROSE_NO_LABEL, criteria: { expected_schema: { type: 'object', required: ['summary'] } }, pass: false },

  // 5. Honest disclosure section vs. the deliverable it follows
  { name: 'short answer + required "Not done" section', output: PARIS_WITH_DISCLOSURE, criteria: { min_length: 10 }, pass: true },
  { name: 'one character + long "Not done" section', output: `x\n\nNot done / assumptions: ${'I assumed the brief meant the latest quarter and used public figures. '.repeat(3)}`, criteria: { min_length: 10 }, pass: false },
  { name: 'only a disclosure section, no excuse phrase', output: '**Assumptions:**\n- the brief meant the latest quarter\n- public figures are acceptable for this purpose', criteria: { min_length: 10 }, pass: false },
  { name: 'long deliverable with a first-person gap mid-text', output: LONG_WITH_FIRST_PERSON_GAP, criteria: { min_length: 40 }, pass: true },
  { name: 'incident report whose subject is failures', output: INCIDENT_REPORT, criteria: { min_length: 40 }, pass: true },
  { name: 'code snippet that throws a failure-phrase error', output: CODE_SNIPPET, criteria: { min_length: 40 }, pass: true },

  // 6. Junk that used to pass — each row under min_length 40 and 10
  ...([40, 10] as const).flatMap((min_length): Row[] => [
    { name: `[${min_length}] excuse + filler`, output: EXCUSE_PLUS_FILLER, criteria: { min_length }, pass: false },
    { name: `[${min_length}] "As an AI language model"`, output: 'As an AI language model, I cannot help with this request, but I hope you find what you need elsewhere.', criteria: { min_length }, pass: false },
    { name: `[${min_length}] "I'm sorry, but I can't assist"`, output: "I'm sorry, but I can't assist with that request. Please try a different provider or rephrase it.", criteria: { min_length }, pass: false },
    { name: `[${min_length}] no internet access`, output: "I don't have access to the internet so I can't do this. You may want to look it up yourself.", criteria: { min_length }, pass: false },
    { name: `[${min_length}] "Unfortunately I wasn't able to finish"`, output: "Unfortunately I wasn't able to finish. The work ran out of time before anything was produced.", criteria: { min_length }, pass: false },
    { name: `[${min_length}] "I am unable to finish this task"`, output: 'I am unable to finish this task with the tools that are available to me right now.', criteria: { min_length }, pass: false },
    { name: `[${min_length}] "I cannot complete this task"`, output: 'I cannot complete this task given the constraints that were described in the brief.', criteria: { min_length }, pass: false },
    { name: `[${min_length}] excuse split by a newline`, output: `I was unable\nto complete the task.${FILLER}`, criteria: { min_length }, pass: false },
    { name: `[${min_length}] excuse with double spaces`, output: `I  was  unable  to  complete  the  task.${FILLER}`, criteria: { min_length }, pass: false },
    { name: `[${min_length}] excuse with zero-width characters`, output: `I was un${ZW}able to com${ZW}plete the task.${FILLER}`, criteria: { min_length }, pass: false },
    { name: `[${min_length}] excuse with NBSP`, output: `I was\u00a0unable\u00a0to complete the task.${FILLER}`, criteria: { min_length }, pass: false },
    { name: `[${min_length}] excuse with Cyrillic homoglyphs`, output: `I w\u0430s un\u0430bl\u0435 t\u043e c\u043empl\u0435t\u0435 the task.${FILLER}`, criteria: { min_length }, pass: false },
    { name: `[${min_length}] one letter repeated`, output: 'a'.repeat(40), criteria: { min_length }, pass: false },
    { name: `[${min_length}] dots`, output: '.'.repeat(40), criteria: { min_length }, pass: false },
    { name: `[${min_length}] emoji`, output: '👍'.repeat(20), criteria: { min_length }, pass: false },
    { name: `[${min_length}] "ok" padded with zero-width characters`, output: `ok${ZW.repeat(40)}`, criteria: { min_length }, pass: false },
    { name: `[${min_length}] "o k" padded with spaces`, output: `o${' '.repeat(40)}k`, criteria: { min_length }, pass: false },
    { name: `[${min_length}] error marker after a prefix`, output: 'Result: Error during LLM execution: 429 rate limited by the upstream provider, please retry later', criteria: { min_length }, pass: false },
    { name: `[${min_length}] "LLM execution failed" marker`, output: 'Error: LLM execution failed with status 500 from the upstream provider after three attempts', criteria: { min_length }, pass: false },
  ]),

  // 7. A check that cannot run must not pay
  { name: 'unsafe regex_pattern fails closed', output: 'x', criteria: { regex_pattern: '(a+)+$' }, pass: false },
  { name: 'unsafe regex_pattern fails closed even for real content', output: LEGIT_REPORT, criteria: { regex_pattern: '(a+)+$', min_length: 40 }, pass: false },
  { name: 'uncompilable regex_pattern fails closed', output: 'x', criteria: { regex_pattern: '([' }, pass: false },
  { name: 'backtracking regex that slips the static guard times out closed', output: 'a'.repeat(41) + 'b', criteria: { regex_pattern: '(a|a)+$' }, pass: false },
  { name: 'second backtracking regex times out closed', output: 'ab'.repeat(30) + 'd', criteria: { regex_pattern: '^(a|b|ab)*c' }, pass: false },
  { name: 'usable regex still lifts the floor', output: HASH_ANSWER, criteria: { regex_pattern: '^[0-9a-f]{64}$' }, pass: true },

  // 8. required_fields need values, not just keys or labels
  { name: 'required_fields with empty strings', output: '{"summary":"","score":""}', criteria: { required_fields: ['summary', 'score'] }, pass: false },
  { name: 'required_fields with empty containers', output: '{"summary":{},"score":[]}', criteria: { required_fields: ['summary', 'score'] }, pass: false },
  { name: 'required_fields keeps 0 and false as values', output: '{"summary":false,"score":0}', criteria: { required_fields: ['summary', 'score'] }, pass: true },
  { name: 'bare prose labels', output: 'Summary:\nScore:', criteria: { required_fields: ['summary', 'score'] }, pass: false },
  { name: 'bare prose labels on one line', output: 'Summary: Score:', criteria: { required_fields: ['summary', 'score'] }, pass: false },
  { name: 'expected_schema required keys with empty values', output: '{"summary":""}', criteria: { expected_schema: { type: 'object', required: ['summary'] } }, pass: false },
  { name: 'schema without required keys does not lift the floor', output: '{}', criteria: { expected_schema: { type: 'object' } }, pass: false },

  // 9. expected_answer: tolerant of dressing, not of a bag of guesses
  { name: 'expected answer with a trailing period', output: 'Paris.', criteria: { expected_answer: 'Paris' }, pass: true },
  { name: 'expected answer in markdown bold', output: '**Paris**', criteria: { expected_answer: 'Paris' }, pass: true },
  { name: 'expected answer in a sentence', output: 'The answer is 42.', criteria: { expected_answer: '42' }, pass: true },
  { name: 'expected answer in a fuller sentence', output: 'The capital of France is Paris.', criteria: { expected_answer: 'Paris' }, pass: true },
  { name: 'yes', output: 'Yes.', criteria: { expected_answer: 'yes' }, pass: true },
  { name: 'URL answer', output: URL_ANSWER, criteria: { expected_answer: URL_ANSWER }, pass: true },
  { name: 'hash answer', output: `\`${HASH_ANSWER}\``, criteria: { expected_answer: HASH_ANSWER }, pass: true },
  { name: 'bag of guesses', output: 'yes no 42 41 43 true false maybe', criteria: { expected_answer: '42' }, pass: false },
  { name: 'two numeric guesses', output: '42 41', criteria: { expected_answer: '42' }, pass: false },
  { name: 'yes and no', output: 'yes, or possibly no', criteria: { expected_answer: 'yes' }, pass: false },
  { name: 'bag of word guesses', output: 'london berlin madrid rome paris vienna', criteria: { expected_answer: 'Paris' }, pass: false },

  // 4. Rental ("Use now") default criteria
  { name: 'rental: correct 28-character URL', output: URL_ANSWER, criteria: RENTAL, pass: true },
  { name: 'rental: one-character result', output: 'x', criteria: RENTAL, pass: false },
  { name: 'rental: 20-character result', output: 'x'.repeat(20), criteria: RENTAL, pass: false },
  { name: 'rental: excuse', output: EXCUSE, criteria: RENTAL, pass: false },
  { name: 'rental: real answer', output: 'The capital of France is Paris, on the river Seine.', criteria: RENTAL, pass: true },
];

describe('autoVerify — regression table', () => {
  it.each(TABLE)('$name → pass=$pass', ({ output, criteria, pass }) => {
    const result = autoVerify({ output }, criteria);
    expect({ passed: result.passed, score: result.score, reasons: result.reasons })
      .toMatchObject({ passed: pass });
  });

  it('reports a clear reason when expected_schema gets non-JSON output', () => {
    const result = autoVerify({ output: PROSE_NO_LABEL }, { expected_schema: { type: 'object', required: ['summary'] } });
    expect(result.reasons).toContain('expected_schema: output is not JSON');
    expect(result.errors).toEqual({});
  });

  // autoVerify runs synchronously in a request handler on a single-threaded
  // server: anything superlinear in the worker-controlled output is a DoS.
  // The first three die on the variety floor; the rest clear it and reach the
  // phrase scan, the disclosure split and the rubrics.
  it.each([
    'status ', 'sorry ', 'incomplete ',
    'status alpha beta ', 'sorry alpha beta ', 'task alpha beta ', 'incomplete alpha beta ',
    'I was unable to ', 'alpha beta gamma. I cannot ', '# Not done\n', '## Not done\nalpha beta gamma\n### sub\n',
    'Summary alpha beta.  \t ', '{"a":', 'alpha\u200b beta\u00a0 g\u0430mma ',
  ])(
    'stays linear on 2 MB of %j',
    (unit) => {
      const output = unit.repeat(Math.ceil(2_000_000 / unit.length));
      const started = performance.now();
      const result = autoVerify({ output }, {
        min_length: 40,
        contains_keywords: ['status'],
        required_fields: ['summary'],
        expected_answer: 'forty two',
        regex_pattern: 'zzz$',
      });
      // 2 MB of worker-controlled output must verify in well under a second
      // alone; the budget here is generous (3s) because CI and parallel test
      // workers contend for CPU, but it still catches the O(n²) blowup this
      // guard exists for (that would be 10x+ slower).
      expect(performance.now() - started).toBeLessThan(3000);
      expect(result.passed).toBe(false);
    },
  );

  it('says why when a regex_pattern cannot be applied', () => {
    expect(autoVerify({ output: LEGIT_REPORT }, { regex_pattern: '([' }).reasons[0]).toMatch(/regex_pattern/);
    expect(autoVerify({ output: 'a'.repeat(41) + 'b' }, { regex_pattern: '(a|a)+$' }).reasons[0]).toMatch(/regex_pattern.*timed out/i);
  });

  it('short-answer criteria lift the content floor', () => {
    expect(autoVerify({ output: 'Paris' }, { min_length: 1, expected_answer: 'Paris' }).passed).toBe(true);
  });
});
