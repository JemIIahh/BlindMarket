import { describe, expect, it } from 'vitest';
import { storageIdSchema } from './storageId.js';

describe('storageIdSchema (audit run 1, C24)', () => {
  it.each([
    'ab'.repeat(32),
    `0x${'CD'.repeat(32)}`,
    'M4hsZGQ1oCktdzegB6HnI1Mzc3Lk7EYv3ZHXlOiQ-zw',
  ])('accepts %s', (id) => {
    expect(storageIdSchema.safeParse(id).success).toBe(true);
  });

  it.each([
    '../a2a/semantic-candidates?q=inject',
    '../agents/some-agent-id/logs/json',
    '%2e%2e%2fagents',
    'a/b',
    `${'ab'.repeat(32)}/..`,
    '',
    'short',
  ])('refuses %s', (id) => {
    expect(storageIdSchema.safeParse(id).success).toBe(false);
  });
});
