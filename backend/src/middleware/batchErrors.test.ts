import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { invalidRows, zodIssuesText } from './batchErrors.js';

/**
 * The batch routes' refusal text (docs/BULK-POSTING.md): a summary people
 * read, counting rows from 1 as the web app and the CLI do, and the rows
 * clients read, by 0-based position in the request.
 *
 * Run: npx vitest run src/middleware/batchErrors.test.ts
 */

describe('invalidRows', () => {
  it('counts rows from 1 in the message and keeps details.errors[].index 0-based', () => {
    const err = invalidRows('INVALID_TASKS', 'task', 5, [
      { index: 3, code: 'VERIFICATION_MODE_UNSUPPORTED', message: "verificationMode='oracle' is not supported." },
      { index: 1, code: 'INVALID_AMOUNT', message: 'amount must be a whole number above 0' },
    ]);
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('INVALID_TASKS');
    expect(err.message).toBe("2 of 5 tasks are invalid: task 2: amount must be a whole number above 0; task 4: verificationMode='oracle' is not supported");
    expect(err.details).toEqual({
      errors: [
        { index: 1, code: 'INVALID_AMOUNT', message: 'amount must be a whole number above 0' },
        { index: 3, code: 'VERIFICATION_MODE_UNSUPPORTED', message: "verificationMode='oracle' is not supported." },
      ],
    });
  });

  it('agrees in number for one refused row, and keeps extra detail', () => {
    const err = invalidRows('INVALID_ITEMS', 'brief', 3, [{ index: 0, code: 'EMPTY_DATA', message: 'Data must not be empty' }], { index: 0 });
    expect(err.message).toBe('1 of 3 briefs is invalid: brief 1: Data must not be empty');
    expect(err.details).toEqual({ index: 0, errors: [{ index: 0, code: 'EMPTY_DATA', message: 'Data must not be empty' }] });
  });

  it('names five rows in the message and every row in the details', () => {
    const errors = Array.from({ length: 7 }, (_, index) => ({ index, code: 'X', message: `bad ${index}` }));
    const err = invalidRows('INVALID_TASKS', 'task', 7, errors);
    expect(err.message).toBe('7 of 7 tasks are invalid: task 1: bad 0; task 2: bad 1; task 3: bad 2; task 4: bad 3; task 5: bad 4; …');
    expect((err.details as { errors: unknown[] }).errors).toHaveLength(7);
  });
});

describe('zodIssuesText', () => {
  const schema = z.object({
    mode: z.enum(['manual', 'auto']),
    keys: z.record(z.string().regex(/^0x/, 'key must be 0x hex'), z.string()),
    list: z.array(z.number()),
  });

  it('names the field and never repeats the value or a free-form key', () => {
    const parsed = schema.safeParse({ mode: 'SECRET-MODE', keys: { 'SECRET-KEY': 'v' }, list: ['x'] });
    expect(parsed.success).toBe(false);
    const text = zodIssuesText(parsed.error!);
    expect(text).not.toContain('SECRET');
    expect(text).toContain("mode: must be one of 'manual', 'auto'");
    expect(text).toContain('keys.[key]: key must be 0x hex');
    expect(text).toContain('list.0: Expected number, received string');
  });

  it("calls a malformed body's own problem 'body'", () => {
    const parsed = schema.safeParse('not an object');
    expect(zodIssuesText(parsed.error!)).toBe('body: Expected object, received string');
  });
});
