import { describe, it, expect, vi } from 'vitest';

// Same tripwires as app.test.ts: the admin tool must not pull in marketplace code either.
vi.mock('../config.js', () => {
  throw new Error('waitlist admin imported the marketplace config');
});
vi.mock('../services/neonDb.js', () => {
  throw new Error('waitlist admin imported the marketplace database');
});

const { parseAdminArgs, toCsv, formatTop, CHECK_LINKS } = await import('./admin.js');

const ROW = {
  position: 1,
  id: 42,
  email: 'ada@example.com',
  handle: 'ada_l',
  tasks: ['follow', 'repost'] as ('follow' | 'like' | 'repost' | 'comment')[],
  taskPoints: 2,
  referrals: 3,
  points: 8,
  joinedAt: new Date('2026-09-12T10:00:00Z'),
};

describe('parseAdminArgs', () => {
  it('top defaults to 50, takes N and --csv in any order', () => {
    expect(parseAdminArgs(['top'])).toEqual({ kind: 'top', limit: 50, csv: false });
    expect(parseAdminArgs(['top', '25', '--csv'])).toEqual({ kind: 'top', limit: 25, csv: true });
    expect(parseAdminArgs(['top', '--csv', '10'])).toEqual({ kind: 'top', limit: 10, csv: true });
  });

  it.each([['0'], ['-3'], ['2.5'], ['lots']])('rejects top %s', (n) => {
    expect(() => parseAdminArgs(['top', n])).toThrow(/whole number/);
  });

  it('revoke takes an id and known task names, de-duplicated', () => {
    expect(parseAdminArgs(['revoke', '42', 'like', 'repost', 'like'])).toEqual({ kind: 'revoke', id: 42, tasks: ['like', 'repost'] });
  });

  it('refuses a revoke it can’t act on precisely', () => {
    expect(() => parseAdminArgs(['revoke', 'ada@example.com', 'like'])).toThrow(/signup id/);
    expect(() => parseAdminArgs(['revoke', '42'])).toThrow(/at least one task/);
    expect(() => parseAdminArgs(['revoke', '42', 'likes'])).toThrow(/unknown task/);
  });

  it('prints usage for anything else', () => {
    expect(() => parseAdminArgs([])).toThrow(/usage/);
    expect(() => parseAdminArgs(['delete', '42'])).toThrow(/usage/);
  });
});

describe('toCsv', () => {
  it('writes one column per task and escapes awkward values', () => {
    const csv = toCsv([ROW, { ...ROW, position: 2, id: 43, email: 'o"brien,x@example.com', handle: null, tasks: [] }]).trim().split('\n');
    expect(csv[0]).toBe('position,id,handle,profile,email,follow,like,repost,comment,task_points,referrals,points,joined_at');
    expect(csv[1]).toBe('1,42,@ada_l,https://x.com/ada_l,ada@example.com,yes,,yes,,2,3,8,2026-09-12T10:00:00.000Z');
    expect(csv[2]).toBe('2,43,,,"o""brien,x@example.com",,,,,2,3,8,2026-09-12T10:00:00.000Z');
  });
});

describe('formatTop', () => {
  it('shows the links to check against and each row’s claims', () => {
    const out = formatTop([ROW]);
    for (const link of Object.values(CHECK_LINKS)) expect(out).toContain(link);
    expect(out).toContain('status/2098305130835607945/likes');
    expect(out).toMatch(/#1\s+42\s+@ada_l\s+F · R ·\s+2\s+3\s+8\s+ada@example\.com/);
  });
});
