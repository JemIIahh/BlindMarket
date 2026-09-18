import { describe, it, expect, vi } from 'vitest';

vi.mock('ai', () => ({ tool: (d: unknown) => d, generateText: vi.fn(), generateObject: vi.fn(), stepCountIs: (n: number) => n }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: () => () => 'm' }));
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: () => () => 'm' }));
vi.mock('@ai-sdk/groq', () => ({ createGroq: () => () => 'm' }));
vi.mock('socket.io-client', () => ({ io: () => ({ on: vi.fn(), emit: vi.fn() }) }));

import {
  isTransientAcceptRefusal,
  isTerminalResumeRefusal,
  isInReleaseCooldown,
  errorCodeOf,
  labelThreadMessage,
  describeVerificationCriteria,
  failedSelfChecks,
  lastNonEmptyStepText,
  // @ts-expect-error — plain-JS worker, no d.ts
} from './worker.js';

describe('isTransientAcceptRefusal — only self-clearing refusals skip the 30-min mark', () => {
  it.each(['OFFER_HELD', 'ACCEPT_LOCKED', 'NOT_OPEN'])('409 %s is transient', (code) => {
    expect(isTransientAcceptRefusal(409, code)).toBe(true);
  });

  it.each(['ASSIGNED_ELSEWHERE', 'TASK_CANCELLED', 'TASK_EXPIRED', 'INVALID_STATE'])('409 %s is terminal', (code) => {
    expect(isTransientAcceptRefusal(409, code)).toBe(false);
  });

  it('403s are never transient, whatever the code', () => {
    expect(isTransientAcceptRefusal(403, 'NEEDS_WRAP')).toBe(false);
    expect(isTransientAcceptRefusal(403, 'NOT_OPEN')).toBe(false);
    expect(isTransientAcceptRefusal(403, 'SELF_ACCEPT')).toBe(false);
  });

  it('503 ASSIGNMENT_PENDING is not a 409-class refusal — fresh accept never blacklists a 5xx, resume owns it', () => {
    expect(isTransientAcceptRefusal(503, 'ASSIGNMENT_PENDING')).toBe(false);
    expect(isTerminalResumeRefusal(503, 'ASSIGNMENT_PENDING')).toBe(false);
  });

  it('a missing code is not transient', () => {
    expect(isTransientAcceptRefusal(409, undefined)).toBe(false);
    expect(isTransientAcceptRefusal(409, '')).toBe(false);
  });
});

describe('isTerminalResumeRefusal — resume only releases a task that is truly not ours', () => {
  it.each([
    [503, 'SETTLEMENT_FAILED'],
    [503, 'ASSIGNMENT_PENDING'],
    [503, 'BRIDGE_FAILED'],
    [500, ''],
    [502, ''],
    [429, ''],
    [0, 'NETWORK_ERROR (fetch failed)'],
    [409, 'ACCEPT_LOCKED'],
    [409, 'NOT_OPEN'],
    [409, 'OFFER_HELD'],
  ])('%i %s keeps the task', (status, code) => {
    expect(isTerminalResumeRefusal(status, code)).toBe(false);
  });

  it.each([
    [409, 'ASSIGNED_ELSEWHERE'],
    [409, 'TASK_CANCELLED'],
    [409, 'TASK_EXPIRED'],
    [403, 'NEEDS_WRAP'],
    [404, 'NOT_FOUND'],
  ])('%i %s is terminal', (status, code) => {
    expect(isTerminalResumeRefusal(status, code)).toBe(true);
  });
});

describe('isInReleaseCooldown — a worker must not re-accept what it just released', () => {
  const T0 = 1_700_000_000_000;
  const MIN = 60_000;

  it('never-released tasks are not cooling down', () => {
    expect(isInReleaseCooldown(undefined, T0, 15 * MIN, 30 * MIN)).toBe(false);
  });

  it('one release blocks for the cooldown, then clears', () => {
    const entry = { at: T0, count: 1 };
    expect(isInReleaseCooldown(entry, T0, 15 * MIN, 30 * MIN)).toBe(true);
    expect(isInReleaseCooldown(entry, T0 + 15 * MIN - 1, 15 * MIN, 30 * MIN)).toBe(true);
    expect(isInReleaseCooldown(entry, T0 + 15 * MIN, 15 * MIN, 30 * MIN)).toBe(false);
  });

  it('a second release earns the full applied-mark TTL', () => {
    const entry = { at: T0, count: 2 };
    expect(isInReleaseCooldown(entry, T0 + 15 * MIN, 15 * MIN, 30 * MIN)).toBe(true);
    expect(isInReleaseCooldown(entry, T0 + 30 * MIN, 15 * MIN, 30 * MIN)).toBe(false);
  });

  it('a repeat never shortens a cooldown configured above the TTL', () => {
    expect(isInReleaseCooldown({ at: T0, count: 3 }, T0 + 45 * MIN, 60 * MIN, 30 * MIN)).toBe(true);
  });

  it('defaults: 15 min cooldown, 30 min on repeat', () => {
    expect(isInReleaseCooldown({ at: T0, count: 1 }, T0 + 14 * MIN)).toBe(true);
    expect(isInReleaseCooldown({ at: T0, count: 1 }, T0 + 16 * MIN)).toBe(false);
    expect(isInReleaseCooldown({ at: T0, count: 2 }, T0 + 29 * MIN)).toBe(true);
  });
});

describe('errorCodeOf', () => {
  it('reads the code from the backend error envelope', () => {
    expect(errorCodeOf(JSON.stringify({ success: false, error: { code: 'ON_CHAIN_LOCKED', message: 'x' } }))).toBe('ON_CHAIN_LOCKED');
  });

  it("returns '' for non-JSON, empty, or differently-shaped bodies", () => {
    expect(errorCodeOf('<html>502</html>')).toBe('');
    expect(errorCodeOf('')).toBe('');
    expect(errorCodeOf('{"error":"nope"}')).toBe('');
    expect(errorCodeOf('{"error":{"code":42}}')).toBe('');
    expect(errorCodeOf('null')).toBe('');
  });
});

describe('labelThreadMessage', () => {
  const POSTER = '0xAbCd000000000000000000000000000000000001';
  const SELF = '0x1234000000000000000000000000000000000002';
  const STRANGER = '0x9999000000000000000000000000000000000003';

  it('labels the poster, case-insensitively', () => {
    expect(labelThreadMessage(POSTER.toLowerCase(), POSTER, [SELF])).toBe('[Poster]');
  });

  it('labels our own addresses, skipping empty entries', () => {
    expect(labelThreadMessage(SELF.toUpperCase().replace('0X', '0x'), POSTER, [null, '', SELF])).toBe('[You]');
  });

  it('drops anyone else', () => {
    expect(labelThreadMessage(STRANGER, POSTER, [SELF])).toBeNull();
  });

  it('drops everything from others when the poster is unknown', () => {
    expect(labelThreadMessage(POSTER, null, [SELF])).toBeNull();
    expect(labelThreadMessage(SELF, null, [SELF])).toBe('[You]');
  });

  it('drops rows with no sender', () => {
    expect(labelThreadMessage(undefined, POSTER, [SELF])).toBeNull();
    expect(labelThreadMessage('', '', [''])).toBeNull();
  });
});

describe('describeVerificationCriteria', () => {
  it("returns '' when there is nothing to describe", () => {
    expect(describeVerificationCriteria(null)).toBe('');
    expect(describeVerificationCriteria({})).toBe('');
    expect(describeVerificationCriteria({ pass_threshold: 80 })).toBe('');
  });

  it('describes only the keys present', () => {
    const out = describeVerificationCriteria({ min_length: 500, contains_keywords: ['risk', 'APY'] });
    expect(out.startsWith('[VERIFICATION]')).toBe(true);
    expect(out).toContain('at least 500 characters');
    expect(out).toContain('"risk", "APY"');
    expect(out).not.toContain('at most');
    expect(out).not.toContain('JSON');
    expect(out).not.toContain('NOT contain');
    expect(out).not.toContain('regular expression');
    expect(out).not.toContain('/100');
  });

  it('says the whole output must be JSON when fields or a schema are required', () => {
    const out = describeVerificationCriteria({
      required_fields: ['summary'],
      expected_schema: { required: ['summary', 'score'], properties: { score: { type: 'number' } } },
    });
    expect(out).toContain('valid JSON');
    expect(out).toContain('"summary", "score"');
    expect(out).toContain('score (number)');
    expect(describeVerificationCriteria({ expected_schema: { type: 'object' } })).toContain('valid JSON');
  });

  it('covers max length, forbidden phrases, regex, rubric and threshold', () => {
    const out = describeVerificationCriteria({
      max_length: 2000,
      forbidden_phrases: ['as an AI'],
      regex_pattern: '^# ',
      rubric: [{ criterion: 'Covers fees', keywords: ['fee'], min_mentions: 2 }, { criterion: 'Tone' }],
      pass_threshold: 75,
    });
    expect(out).toContain('at most 2000 characters');
    expect(out).toContain('"as an AI"');
    expect(out).toContain('^# ');
    expect(out).toContain('Rubric: Covers fees');
    expect(out).toContain('(at least 2)');
    expect(out).toContain('Rubric: Tone.');
    expect(out).toContain('75/100');
  });
});

describe('failedSelfChecks', () => {
  it('passes with no criteria or when every check is met', () => {
    expect(failedSelfChecks('anything', null)).toEqual([]);
    expect(failedSelfChecks('Risk and apy covered', { min_length: 10, contains_keywords: ['risk', 'APY'] })).toEqual([]);
  });

  it('flags short output and missing keywords', () => {
    const f = failedSelfChecks('short', { min_length: 100, contains_keywords: ['risk', 'short'] });
    expect(f).toHaveLength(2);
    expect(f[0]).toContain('at least 100');
    expect(f[1]).toContain('"risk"');
    expect(f[1]).not.toContain('"short"');
  });

  it('flags non-JSON output when fields are required — a fenced block does not parse', () => {
    const f = failedSelfChecks('```json\n{"summary":"x"}\n```', { required_fields: ['summary'] });
    expect(f).toHaveLength(1);
    expect(f[0]).toContain('not valid JSON');
  });

  it('flags missing or null fields, from required_fields and expected_schema.required', () => {
    const f = failedSelfChecks('{"summary":"x","score":null}', {
      required_fields: ['summary'],
      expected_schema: { required: ['score', 'sources'] },
    });
    expect(f).toHaveLength(1);
    expect(f[0]).toContain('"score"');
    expect(f[0]).toContain('"sources"');
    expect(f[0]).not.toContain('"summary"');
  });

  it('treats a non-object JSON value as missing every field', () => {
    expect(failedSelfChecks('42', { required_fields: ['a'] })[0]).toContain('"a"');
    expect(failedSelfChecks('null', { required_fields: ['a'] })[0]).toContain('"a"');
  });

  it('accepts valid JSON with all fields', () => {
    expect(failedSelfChecks('{"a":1,"b":"x"}', { required_fields: ['a'], expected_schema: { required: ['b'] } })).toEqual([]);
  });
});

describe('lastNonEmptyStepText', () => {
  it('returns the last step that has text, skipping a text-less tool step at the cap', () => {
    const steps = [
      { text: 'draft one' },
      { text: '  the real answer  ', toolCalls: [{}] },
      { text: '', toolCalls: [{}], toolResults: [{ output: 'TOOL OUTPUT MUST NOT BE USED' }] },
    ];
    expect(lastNonEmptyStepText(steps)).toBe('the real answer');
  });

  it("returns '' when no step wrote text, or steps is missing", () => {
    expect(lastNonEmptyStepText([{ text: '  ' }, { toolResults: [{ output: 'x' }] }])).toBe('');
    expect(lastNonEmptyStepText(undefined)).toBe('');
    expect(lastNonEmptyStepText([])).toBe('');
  });
});
