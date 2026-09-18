import { describe, it, expect } from 'vitest';
import {
  ContainsKeywords,
  LengthBetween,
  JsonSchema,
  HasFields,
  extractJsonObject,
  MatchesRegex,
  NoForbiddenPhrases,
  WeightedRubric,
  AllRubric,
  isSafeRegexSource,
  testRegexBounded,
  RegexTimeoutError,
} from './rubricEngine.js';

describe('isSafeRegexSource (ReDoS guard)', () => {
  it('rejects nested-quantifier (catastrophic) patterns', () => {
    expect(isSafeRegexSource('^(a+)+$')).toBe(false);
    expect(isSafeRegexSource('(a*)*')).toBe(false);
    expect(isSafeRegexSource('((a+))+')).toBe(false);   // nested groups
    expect(isSafeRegexSource('(a+|b)+')).toBe(false);    // quantifier inside alternation group
    expect(isSafeRegexSource('(.*)+')).toBe(false);
    expect(isSafeRegexSource('(a{2,})+')).toBe(false);   // {n,} counts as a quantifier
  });

  it('accepts ordinary, linear patterns', () => {
    expect(isSafeRegexSource('^\\d{4}-\\d{2}-\\d{2}$')).toBe(true);
    expect(isSafeRegexSource('(abc)+')).toBe(true);       // quantified group, no inner quantifier
    expect(isSafeRegexSource('(a|b)+')).toBe(true);        // alternation, no inner quantifier
    expect(isSafeRegexSource('foo.*bar')).toBe(true);
    expect(isSafeRegexSource('[a-z]+@[a-z]+\\.[a-z]+')).toBe(true);
    expect(isSafeRegexSource('a+')).toBe(true);
  });

  it('rejects over-long patterns', () => {
    expect(isSafeRegexSource('a'.repeat(201))).toBe(false);
  });
});

describe('ContainsKeywords', () => {
  it('scores 1.0 when all keywords present', () => {
    const rubric = ContainsKeywords(['hello', 'world']);
    expect(rubric('hello world')).toBe(1);
  });

  it('scores partial match', () => {
    const rubric = ContainsKeywords(['hello', 'world', 'foo']);
    expect(rubric('hello world')).toBeCloseTo(0.666, 2);
  });

  it('scores 0 when no keywords present', () => {
    const rubric = ContainsKeywords(['hello', 'world']);
    expect(rubric('nothing here')).toBe(0);
  });

  it('handles empty keywords', () => {
    const rubric = ContainsKeywords([]);
    expect(rubric('anything')).toBe(1);
  });

  it('is case-insensitive', () => {
    const rubric = ContainsKeywords(['Hello']);
    expect(rubric('hello')).toBe(1);
  });
});

describe('LengthBetween', () => {
  it('scores 1.0 within range', () => {
    const rubric = LengthBetween(5, 20);
    expect(rubric('hello')).toBe(1);
  });

  it('scores partial when below min', () => {
    const rubric = LengthBetween(10);
    expect(rubric('hi')).toBeCloseTo(0.2, 1);
  });

  it('scores partial when above max', () => {
    const rubric = LengthBetween(0, 5);
    expect(rubric('hello world')).toBeCloseTo(0.454, 2);
  });

  it('open-ended max', () => {
    const rubric = LengthBetween(5);
    expect(rubric('a'.repeat(1000))).toBe(1);
  });
});

describe('JsonSchema', () => {
  it('scores 1.0 for valid JSON matching schema', () => {
    const rubric = JsonSchema({
      type: 'object',
      required: ['status', 'items'],
    });
    expect(rubric(JSON.stringify({ status: 'ok', items: [1, 2] }))).toBe(1);
  });

  it('scores partial when missing required fields', () => {
    const rubric = JsonSchema({
      required: ['a', 'b', 'c'],
    });
    expect(rubric(JSON.stringify({ a: 1, b: 2 }))).toBeCloseTo(0.666, 2);
  });

  it('scores 0 for invalid JSON', () => {
    const rubric = JsonSchema({ type: 'object' });
    expect(rubric('not json')).toBe(0);
  });

  it('scores 0 when type mismatch', () => {
    const rubric = JsonSchema({ type: 'object' });
    expect(rubric(JSON.stringify([1, 2, 3]))).toBe(0);
  });
});

describe('extractJsonObject', () => {
  it('parses bare JSON', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('pulls JSON out of a fenced block', () => {
    expect(extractJsonObject('Result:\n```json\n{"a": 1}\n```\nDone.')).toEqual({ a: 1 });
  });

  it('pulls the first balanced object out of prose, ignoring braces in strings', () => {
    expect(extractJsonObject('Here you go: {"a": "x}y", "b": {"c": 2}} — enjoy')).toEqual({ a: 'x}y', b: { c: 2 } });
  });

  it('skips a non-JSON brace group and finds the next object', () => {
    expect(extractJsonObject('use {placeholder} then {"a":1}')).toEqual({ a: 1 });
  });

  it('returns undefined for prose, arrays and unbalanced braces', () => {
    expect(extractJsonObject('no json here')).toBeUndefined();
    expect(extractJsonObject('[1,2,3]')).toBeUndefined();
    expect(extractJsonObject('{"a": 1')).toBeUndefined();
    expect(extractJsonObject('{'.repeat(5000))).toBeUndefined();
  });
});

describe('HasFields', () => {
  it('scores by JSON keys, treating null as absent', () => {
    expect(HasFields(['a', 'b'])(JSON.stringify({ a: 1, b: null }))).toBe(0.5);
  });

  it('reads fields from fenced JSON', () => {
    expect(HasFields(['summary'])('```json\n{"summary":"ok"}\n```')).toBe(1);
  });

  it('falls back to headings and labels in prose', () => {
    const rubric = HasFields(['summary', 'next_steps']);
    expect(rubric('Summary: all good.\n\n## Next steps\nShip it.')).toBe(1);
    expect(rubric('**Summary:** all good. NEXT-STEPS: ship it.')).toBe(1);
    expect(rubric('Summary: all good.')).toBe(0.5);
  });

  it('needs a value, not just the key — but 0 and false are values', () => {
    expect(HasFields(['a', 'b'])('{"a":"","b":"  "}')).toBe(0);
    expect(HasFields(['a', 'b'])('{"a":{},"b":[]}')).toBe(0);
    expect(HasFields(['a', 'b'])('{"a":0,"b":false}')).toBe(1);
  });

  it('does not count a bare prose label', () => {
    const rubric = HasFields(['summary', 'score']);
    expect(rubric('Summary:\nScore:')).toBe(0);
    expect(rubric('Summary: Score:')).toBe(0);
    expect(rubric('Summary:\nScore: 5')).toBe(0.5); // the 5 is the score's, not the summary's
    expect(rubric('## Summary\n\n## Score\n7 out of 10')).toBe(0.5);
    expect(rubric('## Summary\n- Revenue: up 12%\n\n## Score\n7 out of 10')).toBe(1);
  });

  it('does not count a field name used mid-sentence', () => {
    expect(HasFields(['summary'])('In summary the work is done and nothing else is needed.')).toBe(0);
  });
});

describe('JsonSchema — embedded JSON', () => {
  it('accepts a schema match inside a fence or prose', () => {
    const rubric = JsonSchema({ type: 'object', required: ['status'] });
    expect(rubric('```json\n{"status":"ok"}\n```')).toBe(1);
    expect(rubric('Done — {"status":"ok"}')).toBe(1);
  });
});

describe('JsonSchema — required keys need values', () => {
  it('scores an empty required value as missing', () => {
    const rubric = JsonSchema({ type: 'object', required: ['status', 'count'] });
    expect(rubric('{"status":"","count":0}')).toBe(0.5);
  });
});

describe('testRegexBounded', () => {
  // Both pass isSafeRegexSource (it cannot see alternation overlap) and
  // backtrack exponentially; unbounded they hang the process.
  it.each([
    ['(a|a)+$', 'a'.repeat(41) + 'b'],
    ['^(a|b|ab)*c', 'ab'.repeat(30) + 'd'],
  ])('interrupts %s instead of hanging', (source, input) => {
    expect(isSafeRegexSource(source)).toBe(true);
    const started = performance.now();
    expect(() => testRegexBounded(new RegExp(source), input)).toThrow(RegexTimeoutError);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('still answers after a timeout, and honours flags', () => {
    expect(() => testRegexBounded(/(a|a)+$/, 'a'.repeat(41) + 'b')).toThrow(RegexTimeoutError);
    expect(testRegexBounded(/^paris$/i, 'Paris')).toBe(true);
    expect(testRegexBounded(/^paris$/, 'Paris')).toBe(false);
  });
});

describe('MatchesRegex', () => {
  it('scores 1.0 when matched', () => {
    const rubric = MatchesRegex(/\d{4}-\d{2}-\d{2}/);
    expect(rubric('today is 2026-05-28')).toBe(1);
  });

  it('scores 0 when not matched', () => {
    const rubric = MatchesRegex(/\d{4}-\d{2}-\d{2}/);
    expect(rubric('no date here')).toBe(0);
  });
});

describe('NoForbiddenPhrases', () => {
  it('scores 1.0 when clean', () => {
    const rubric = NoForbiddenPhrases(['error', 'failed']);
    expect(rubric('everything is working')).toBe(1);
  });

  it('scores 0 when forbidden phrase found', () => {
    const rubric = NoForbiddenPhrases(['error', 'failed']);
    expect(rubric('an error occurred')).toBe(0);
  });

  it('handles empty phrases', () => {
    const rubric = NoForbiddenPhrases([]);
    expect(rubric('anything')).toBe(1);
  });
});

describe('WeightedRubric', () => {
  it('computes weighted average', () => {
    const rubric = new WeightedRubric([
      { fn: () => 1, weight: 1, name: 'a' },
      { fn: () => 0, weight: 1, name: 'b' },
    ]);
    const result = rubric.score('test');
    expect(result.score).toBeCloseTo(0.5, 2);
    expect(result.passed).toBe(false); // default threshold 0.6
  });

  it('respects pass threshold', () => {
    const rubric = new WeightedRubric([
      { fn: () => 0.8, weight: 1, name: 'a' },
    ]);
    expect(rubric.score('test', 0.7).passed).toBe(true);
    expect(rubric.score('test', 0.9).passed).toBe(false);
  });

  it('isolates exceptions (crash = 0.0)', () => {
    const rubric = new WeightedRubric([
      { fn: () => { throw new Error('boom'); }, weight: 1, name: 'broken' },
      { fn: () => 1, weight: 1, name: 'good' },
    ]);
    const result = rubric.score('test');
    expect(result.score).toBeCloseTo(0.5, 2);
    expect(result.errors['broken']).toContain('boom');
    expect(result.breakdown.find(r => r.name === 'broken')?.error).toBeTruthy();
  });

  it('normalizes weights', () => {
    const rubric = new WeightedRubric([
      { fn: () => 1, weight: 3, name: 'a' },
      { fn: () => 0, weight: 1, name: 'b' },
    ]);
    const result = rubric.score('test');
    expect(result.score).toBeCloseTo(0.75, 2);
  });
});

describe('AllRubric', () => {
  it('passes when all rubrics above threshold', () => {
    const rubric = new AllRubric([
      { fn: () => 0.9, name: 'a' },
      { fn: () => 0.8, name: 'b' },
    ], 0.5);
    expect(rubric.score('test').passed).toBe(true);
  });

  it('fails when any rubric below threshold', () => {
    const rubric = new AllRubric([
      { fn: () => 0.9, name: 'a' },
      { fn: () => 0.3, name: 'b' },
    ], 0.5);
    expect(rubric.score('test').passed).toBe(false);
  });

  it('crashed rubric counts as failure', () => {
    const rubric = new AllRubric([
      { fn: () => { throw new Error('crash'); }, name: 'broken' },
      { fn: () => 1, name: 'good' },
    ], 0.5);
    const result = rubric.score('test');
    expect(result.passed).toBe(false);
    expect(result.errors['broken']).toBeTruthy();
  });
});
