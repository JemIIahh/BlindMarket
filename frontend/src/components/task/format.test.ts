import { describe, expect, it } from 'vitest';
import { cardText, deadlineLabel, formatReward, sumRewards, topRewardIndex, verifyLabel } from './format';

const usdc = (amount: string) => ({ amount, unit: { symbol: 'USDC', decimals: 6 } });

describe('formatReward', () => {
  it('formats base units with the token', () => {
    expect(formatReward(usdc('450000'))).toBe('0.45 USDC');
    expect(formatReward(usdc('2500000'))).toBe('2.50 USDC');
    expect(formatReward(usdc('12345'))).toBe('0.0123 USDC');
    expect(formatReward({ amount: '1500000000000000000', unit: { symbol: '0G', decimals: 18 } })).toBe('1.50 0G');
  });

  it('returns null for a missing or malformed reward', () => {
    expect(formatReward(undefined)).toBeNull();
    expect(formatReward({ amount: '1.5', unit: { symbol: 'USDC', decimals: 6 } })).toBeNull();
    expect(formatReward({ amount: '100' })).toBeNull();
  });
});

describe('sumRewards', () => {
  it('adds rewards per token', () => {
    expect(sumRewards([usdc('450000'), usdc('50000'), undefined])).toBe('0.50 USDC');
    expect(sumRewards([usdc('1000000'), { amount: '500000000000000000', unit: { symbol: '0G', decimals: 18 } }]))
      .toBe('1.00 USDC · 0.50 0G');
    expect(sumRewards([])).toBeNull();
  });
});

describe('topRewardIndex', () => {
  it('picks the single highest reward among three or more', () => {
    expect(topRewardIndex([usdc('250000'), usdc('500000'), usdc('10000')])).toBe(1);
  });

  it('highlights nothing when there is no clear top', () => {
    expect(topRewardIndex([usdc('500000'), usdc('500000'), usdc('10000')])).toBe(-1);
    expect(topRewardIndex([usdc('1'), usdc('2')])).toBe(-1);
    expect(topRewardIndex([usdc('1'), usdc('2'), { amount: '3', unit: { symbol: '0G', decimals: 18 } }])).toBe(-1);
    expect(topRewardIndex([usdc('1'), usdc('2'), undefined])).toBe(-1);
  });
});

describe('deadlineLabel', () => {
  const now = 1_790_000_000_000;
  const at = (ms: number) => (now + ms) / 1000;

  it('counts down in the largest sensible unit', () => {
    expect(deadlineLabel(at(30 * 60_000), now)).toEqual({ text: 'Ends in 30m', tone: 'soon' });
    expect(deadlineLabel(at(20_000), now)).toEqual({ text: 'Ends in 1m', tone: 'soon' });
    expect(deadlineLabel(at(5.5 * 3_600_000), now)).toEqual({ text: 'Ends in 5h', tone: 'soon' });
    expect(deadlineLabel(at(30 * 3_600_000), now)).toEqual({ text: 'Ends in 30h', tone: 'normal' });
    expect(deadlineLabel(at(3 * 86_400_000), now)).toEqual({ text: 'Ends in 3d', tone: 'normal' });
    expect(deadlineLabel(at(64 * 86_400_000), now)).toEqual({ text: 'Ends in 2mo', tone: 'normal' });
  });

  it('says ended once the deadline has passed', () => {
    expect(deadlineLabel(at(-1000), now)).toEqual({ text: 'Ended', tone: 'ended' });
  });

  it('returns null without a deadline', () => {
    expect(deadlineLabel(undefined, now)).toBeNull();
    expect(deadlineLabel(0, now)).toBeNull();
    expect(deadlineLabel('soon', now)).toBeNull();
  });
});

describe('verifyLabel', () => {
  it('names each verification mode', () => {
    expect(verifyLabel('auto')?.label).toBe('Auto check');
    expect(verifyLabel('agent')?.label).toBe('Agent review');
    expect(verifyLabel('manual')?.label).toBe('Poster review');
    expect(verifyLabel('custom')?.label).toBe('Custom');
    expect(verifyLabel(undefined)).toBeNull();
  });
});

describe('cardText', () => {
  it("shows a private task's routing summary, since its brief is sealed", () => {
    expect(cardText({ routingSummary: 'Write 10 launch tweets for a new AI agent marketplace' })).toEqual({
      title: 'Write 10 launch tweets for a new AI agent marketplace',
      description: 'Details are encrypted for the agent who takes it.',
    });
    expect(cardText({})).toEqual({
      title: 'Private task',
      description: 'Details are encrypted for the agent who takes it.',
    });
  });

  it("splits a public task's brief into a title and a short preview", () => {
    expect(cardText({ privacy: 'public', publicBrief: 'TEE vs ZK vs FHE\\n\\nCompare them in one table.\n\nmin_length: 300' }))
      .toEqual({ title: 'TEE vs ZK vs FHE', description: 'Compare them in one table.' });
  });
});
