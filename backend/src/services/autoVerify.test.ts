import { describe, it, expect } from 'vitest';
import { autoVerify } from './autoVerify.js';

describe('autoVerify — backward-compatible (legacy criteria)', () => {
  it('passes with basic criteria met', () => {
    const result = autoVerify(
      { output: 'hello world this is a test' },
      { min_length: 20, contains_keywords: ['hello'] },
    );
    expect(result.passed).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(60);
  });

  it('fails when min_length not met', () => {
    const result = autoVerify(
      { output: 'hi' },
      { min_length: 100 },
    );
    expect(result.passed).toBe(false);
  });

  it('fails when contains_keywords missing', () => {
    const result = autoVerify(
      { output: 'nothing relevant' },
      { contains_keywords: ['quantum', 'physics'] },
    );
    expect(result.passed).toBe(false);
  });

  it('checks required_fields on JSON output', () => {
    const result = autoVerify(
      { status: 'ok', data: [1, 2, 3] },
      { required_fields: ['status', 'data', 'metadata'] },
    );
    // 2/3 fields present = 66.7%, but weighted against other rubrics
    expect(result.score).toBeGreaterThan(0);
    expect(result.breakdown.some(r => r.name === 'required_fields')).toBe(true);
  });
});

describe('autoVerify — new rubric fields', () => {
  it('rejects forbidden phrases', () => {
    const result = autoVerify(
      { output: 'I cannot help with that. Error: access denied.' },
      { forbidden_phrases: ['cannot', 'error'] },
    );
    expect(result.passed).toBe(false);
  });

  it('validates regex pattern', () => {
    const result = autoVerify(
      { output: 'Order #12345 confirmed for 2026-05-28' },
      { regex_pattern: '\\d{4}-\\d{2}-\\d{2}' },
    );
    expect(result.passed).toBe(true);
  });

  it('validates JSON schema', () => {
    const result = autoVerify(
      { output: JSON.stringify({ status: 'ok', items: [1, 2] }) },
      {
        expected_schema: {
          type: 'object',
          required: ['status', 'items'],
        },
      },
    );
    expect(result.passed).toBe(true);
  });

  it('scores custom rubric items', () => {
    const result = autoVerify(
      { output: 'This is a comprehensive analysis of the data with detailed recommendations and actionable insights.' },
      {
        rubric: [
          { criterion: 'has analysis', keywords: ['analysis', 'analysis'] },
          { criterion: 'has recommendations', keywords: ['recommendations', 'suggestions'] },
        ],
      },
    );
    expect(result.passed).toBe(true);
    expect(result.breakdown.some(r => r.name.startsWith('rubric_'))).toBe(true);
  });

  it('respects custom pass_threshold', () => {
    // High threshold should fail when criteria score below it
    const result = autoVerify(
      { output: 'ok' },
      { contains_keywords: ['quantum', 'physics', 'neural', 'networks'], pass_threshold: 95 },
    );
    expect(result.score).toBeLessThan(95);
    expect(result.passed).toBe(false);
  });

  it('expected_answer scores by keyword overlap', () => {
    const result = autoVerify(
      { output: 'Paris is the capital of France and a major European city' },
      { expected_answer: 'Paris France capital' },
    );
    // All 3 words present
    expect(result.score).toBeGreaterThan(50);
  });

  it('max_length penalizes overly long output', () => {
    const short = autoVerify({ output: 'a good, concise answer' }, { max_length: 100 });
    const long = autoVerify({ output: 'x'.repeat(10000) }, { max_length: 100 });
    expect(short.score).toBeGreaterThan(long.score);
  });
});

describe('autoVerify — fallback', () => {
  it('passes when no criteria defined', () => {
    const result = autoVerify({ output: 'anything with real content' }, {});
    expect(result.passed).toBe(true);
  });

  it('hard-fails near-empty output when no min_length is set', () => {
    const result = autoVerify({ output: 'anything' }, {});
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
    expect(result.reasons[0]).toMatch(/too short/i);
  });

  it('scores 0 for empty output with no criteria', () => {
    const result = autoVerify({ output: '' }, {});
    expect(result.score).toBe(0);
  });

  it('hard-fails worker LLM-error markers even when they clear every rubric', () => {
    // Regression: the platform worker used to submit its own catch text
    // ("Error during LLM execution: ...") as the deliverable. It is long
    // enough for min_length and contains no listed forbidden phrase, so the
    // weighted mix scored it 100 and released escrow for zero work.
    const result = autoVerify(
      { output: 'Error during LLM execution: Tool call validation failed: attempted to call tool \'search\' which was not in request.tools' },
      { min_length: 10 },
    );
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
    expect(result.reasons[0]).toMatch(/LLM execution error/);
  });
});

describe('autoVerify — hard gates', () => {
  it('treats min_length as a floor, not a score component', () => {
    // 20/40 chars used to average to 67 with the system rubric and pass.
    const result = autoVerify({ output: 'x'.repeat(20) }, { min_length: 40 });
    expect(result.passed).toBe(false);
    expect(result.reasons[0]).toMatch(/20 characters, minimum 40/);
  });

  it('fails a failure excuse outright', () => {
    const result = autoVerify(
      { output: 'I was unable to complete this task because the service was unavailable.' },
      {},
    );
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
    expect(result.reasons[0]).toMatch(/failure excuse/);
  });

  it('keeps a substantive report that mentions a failure phrase, minus the soft rubric', () => {
    const report = `${'The migration moved every table and the row counts match the source. '.repeat(5)}One index was unable to build online and was rebuilt offline.`;
    const result = autoVerify({ output: report }, { min_length: 100 });
    expect(result.passed).toBe(true);
    expect(result.breakdown.find(r => r.name === 'system_failure_detection')?.score).toBe(0);
  });

  it('scores keyword echo 0 and says why', () => {
    // Four distinct words: a two-word echo now dies earlier, on the variety floor.
    const result = autoVerify({ output: 'revenue churn and revenue churn again' }, { contains_keywords: ['revenue', 'churn'] });
    expect(result.passed).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/besides the keywords/);
  });
});

describe('autoVerify — combined criteria', () => {
  it('scores across multiple dimensions', () => {
    const result = autoVerify(
      {
        output: 'This is a detailed analysis. Key findings: revenue up 15%, costs down 8%. Recommendations: expand into Asian markets, optimize supply chain.',
      },
      {
        min_length: 50,
        contains_keywords: ['analysis', 'revenue', 'recommendations'],
        forbidden_phrases: ['error', 'failed'],
        rubric: [
          { criterion: 'data-driven', keywords: ['15%', '8%', 'revenue'] },
          { criterion: 'actionable', keywords: ['expand', 'optimize'] },
        ],
        pass_threshold: 60,
      },
    );
    expect(result.passed).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.breakdown.length).toBeGreaterThanOrEqual(4);
  });
});
