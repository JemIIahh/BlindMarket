import { describe, expect, it } from 'vitest';
import { scorecardRows } from './openSubmission';

describe('scorecardRows', () => {
  it('keeps the scores best first, with reasons, and why some were not judged', () => {
    const rows = scorecardRows({
      scores: [{ submitter: '0xa', score: 4, reason: 'thin' }, { submitter: '0xb', score: 9 }],
      notJudged: [{ why: 'unreadable', count: 2, submitters: ['0xc', '0xd'] }],
    });
    expect(rows).toEqual({
      scores: [{ submitter: '0xb', score: 9 }, { submitter: '0xa', score: 4, reason: 'thin' }],
      notJudged: [{ why: 'unreadable', count: 2 }],
    });
  });

  it('drops anything not shaped as a score, rather than breaking the page', () => {
    expect(scorecardRows({ scores: 5, notJudged: 'none' })).toEqual({ scores: [], notJudged: [] });
    expect(scorecardRows(null)).toEqual({ scores: [], notJudged: [] });
    expect(scorecardRows('x')).toEqual({ scores: [], notJudged: [] });
    const rows = scorecardRows({
      scores: [null, 3, { submitter: 7, score: 1 }, { submitter: '0xa', score: 'high' }, { submitter: '0xb', score: Number.NaN }, { submitter: '0xc', score: 2, reason: 5 }],
      notJudged: [null, { why: 'late' }, { why: 3, count: 1 }, { why: 'late', count: 1 }],
    });
    expect(rows).toEqual({ scores: [{ submitter: '0xc', score: 2 }], notJudged: [{ why: 'late', count: 1 }] });
  });

  it('keeps one score per submitter, so each row has its own key', () => {
    expect(scorecardRows({ scores: [{ submitter: '0xA', score: 3 }, { submitter: '0xa', score: 8 }] }).scores).toEqual([{ submitter: '0xA', score: 3 }]);
  });
});
