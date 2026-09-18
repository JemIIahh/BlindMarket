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

// The "Use now" rental default sent by UseServiceModal / UseFromAgentModal.
const RENTAL: VerificationCriteria = { min_length: 40 };

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

  // 4. Rental ("Use now") default criteria
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

  it('short-answer criteria lift the content floor', () => {
    expect(autoVerify({ output: 'Paris' }, { min_length: 1, expected_answer: 'Paris' }).passed).toBe(true);
  });
});
