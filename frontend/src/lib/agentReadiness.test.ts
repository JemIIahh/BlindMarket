import { describe, expect, it } from 'vitest';
import { format0g, readinessView, type AgentReadiness } from './agentReadiness';

const at = '2026-09-25T12:00:00.000Z';
const fund = {
  chain: '0g' as const,
  address: '0x3a38cd7A3321A6716815f7B555F4dA6baDCCBC82',
  holdsWei: '1600000000000000000',
  needWei: '3100000000000000000',
  shortfallWei: '1500000000000000000',
};

describe('format0g', () => {
  it('shows whole and decimal amounts plainly', () => {
    expect(format0g('3000000000000000000')).toBe('3');
    expect(format0g('1500000000000000000')).toBe('1.5');
    expect(format0g(0n)).toBe('0');
  });

  it('shows at most 4 decimals, rounding an amount to send up so sending it is enough', () => {
    expect(format0g('1500010000000000000')).toBe('1.5');
    expect(format0g('1500010000000000000', true)).toBe('1.5001');
    expect(format0g('1500000000000000000', true)).toBe('1.5');
  });
});

describe('readinessView', () => {
  it('reads a running agent with no report yet, or one mid-check, as checking', () => {
    expect(readinessView(null)).toEqual({ kind: 'checking' });
    expect(readinessView({ ready: false, checking: true, reason: null, reportedAt: at })).toEqual({ kind: 'checking' });
  });

  it('reads a passed check as taking tasks', () => {
    expect(readinessView({ ready: true, reason: null, reportedAt: at })).toEqual({ kind: 'ready' });
  });

  it('tells the owner how much 0G to send, and where', () => {
    const r: AgentReadiness = { ready: false, reason: 'no 0G Compute account yet', fund, reportedAt: at };
    expect(readinessView(r)).toEqual({ kind: 'fund', address: fund.address, send: '1.5', holds: '1.6', need: '3.1' });
  });

  it('shows any other reason as a sentence', () => {
    expect(readinessView({ ready: false, reason: 'the model deepseek-v4-flash did not answer a test prompt: 401', reportedAt: at }))
      .toEqual({ kind: 'blocked', reason: 'The model deepseek-v4-flash did not answer a test prompt: 401.' });
    expect(readinessView({ ready: false, reason: null, reportedAt: at }))
      .toEqual({ kind: 'blocked', reason: 'Its model check has not passed.' });
  });
});
