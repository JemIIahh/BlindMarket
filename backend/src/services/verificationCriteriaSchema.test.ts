import { describe, expect, it } from 'vitest';
import { CRITERIA_LIMITS, verificationCriteriaSchema } from './verificationCriteriaSchema.js';
import { autoVerify } from './autoVerify.js';

const fields = (n: number) => Array.from({ length: n }, (_, i) => `field_${i}`);

describe('verificationCriteriaSchema', () => {
  it('accepts lists up to the limit and keeps the acceptance hint', () => {
    const parsed = verificationCriteriaSchema.parse({
      required_fields: fields(CRITERIA_LIMITS.listItems),
      contains_keywords: ['revenue'],
      acceptance: 'A runnable Python function.',
    });
    expect(parsed.required_fields).toHaveLength(CRITERIA_LIMITS.listItems);
    expect(parsed.acceptance).toBe('A runnable Python function.');
  });

  it.each([
    ['required_fields', { required_fields: fields(CRITERIA_LIMITS.listItems + 1) }],
    ['contains_keywords', { contains_keywords: fields(CRITERIA_LIMITS.listItems + 1) }],
    ['forbidden_phrases', { forbidden_phrases: fields(CRITERIA_LIMITS.listItems + 1) }],
    ['a long list item', { contains_keywords: ['x'.repeat(CRITERIA_LIMITS.itemChars + 1)] }],
    ['expected_answer', { expected_answer: 'x'.repeat(CRITERIA_LIMITS.expectedAnswerChars + 1) }],
    ['rubric', { rubric: Array.from({ length: CRITERIA_LIMITS.rubricItems + 1 }, (_, i) => ({ criterion: `c${i}` })) }],
    ['schema properties', {
      expected_schema: { properties: Object.fromEntries(fields(CRITERIA_LIMITS.schemaProperties + 1).map((f) => [f, {}])) },
    }],
  ])('refuses too many or too long: %s', (_label, criteria) => {
    expect(verificationCriteriaSchema.safeParse(criteria).success).toBe(false);
  });
});

describe('autoVerify with oversized stored criteria', () => {
  it('refuses 8,000 required_fields at once instead of scoring them (audit run 1, C17)', () => {
    const many = fields(8000);
    const output = many.map((f) => `${f}: value for ${f}.`).join(' ');
    const started = performance.now();
    const result = autoVerify({ output }, { required_fields: many });
    expect(result.passed).toBe(false);
    expect(result.reasons[0]).toMatch(/exceed the supported size/);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
