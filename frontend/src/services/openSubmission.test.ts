import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { checkSelectWinnerTx, scorecardRows } from './openSubmission';

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

const ESCROW = '0x' + 'e5'.repeat(20);
const POSTER = ethers.getAddress('0x' + 'a1'.repeat(20));
const WINNER = ethers.getAddress('0x' + '7e'.repeat(20));
const iface = new ethers.Interface(['function selectWinner(uint256 taskId, address winner, bytes32 scorecardHash)', 'function cancelTask(uint256 taskId)']);
const tx = (over: Record<string, unknown> = {}, args: [bigint, string] = [41n, WINNER]) => ({
  to: ESCROW, from: POSTER, data: iface.encodeFunctionData('selectWinner', [...args, ethers.ZeroHash]), ...over,
});
const expected = { escrow: ESCROW, poster: POSTER.toLowerCase(), onChainTaskId: '41', winner: WINNER.toLowerCase() };

describe("checkSelectWinnerTx: the poster signs only their own pick", () => {
  it('accepts selectWinner for this task and winner, to the escrow, from the poster', () => {
    expect(checkSelectWinnerTx(tx(), expected)).toBeNull();
  });

  it.each([
    ['no transaction', undefined, /no transaction/],
    ['another contract', tx({ to: '0x' + '99'.repeat(20) }), /escrow/],
    ['another wallet', tx({ from: WINNER }), /posted this task/],
    ['value', tx({ value: '1' }), /sends funds/],
    ['another call', tx({ data: iface.encodeFunctionData('cancelTask', [41n]) }), /not a pick/],
    ['another task', tx({}, [42n, WINNER]), /another task/],
    ['another winner', tx({}, [41n, POSTER]), /another winner/],
  ])('refuses %s', (_name, t, why) => {
    expect(checkSelectWinnerTx(t as never, expected)).toMatch(why);
  });

  it('refuses a pick that anchors a scorecard the poster never sent', () => {
    const data = iface.encodeFunctionData('selectWinner', [41n, WINNER, '0x' + '55'.repeat(32)]);
    expect(checkSelectWinnerTx(tx({ data }), expected)).toMatch(/scorecard/);
  });

  it('refuses when the chain has no known escrow', () => {
    expect(checkSelectWinnerTx(tx(), { ...expected, escrow: undefined })).toMatch(/escrow/);
  });
});
