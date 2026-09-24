import { describe, expect, it } from 'vitest';
import { changedTaskTerm, type TaskTerms } from './taskTerms.js';

const listed: TaskTerms = {
  verificationMode: 'auto',
  verificationCriteria: { contains_keywords: ['alpha', 'beta'], pass_threshold: 70 },
  verifierAddress: undefined,
  rootHash: '0xabc123',
  publicBrief: undefined,
  routingSummary: 'Summarise a PDF',
  requiredCapabilities: ['data_processing', 'research'],
};

describe('changedTaskTerm', () => {
  it('a retry that re-sends the original body changes nothing', () => {
    expect(changedTaskTerm(listed, { ...listed })).toBeNull();
  });

  it('ignores key order in criteria and order of capabilities', () => {
    expect(changedTaskTerm(listed, {
      ...listed,
      verificationCriteria: { pass_threshold: 70, contains_keywords: ['alpha', 'beta'] },
      requiredCapabilities: ['research', 'data_processing'],
    })).toBeNull();
  });

  it('treats an omitted mode as manual, and verifier addresses case-insensitively', () => {
    expect(changedTaskTerm({ ...listed, verificationMode: 'manual' }, { ...listed, verificationMode: undefined })).toBeNull();
    expect(changedTaskTerm(
      { ...listed, verifierAddress: '0xabcdef0000000000000000000000000000000001' },
      { ...listed, verifierAddress: '0xABCDEF0000000000000000000000000000000001' },
    )).toBeNull();
  });

  it('refuses switching an auto task to manual (the C01 path)', () => {
    expect(changedTaskTerm(listed, { ...listed, verificationMode: 'manual' })).toBe('verificationMode');
  });

  it('refuses swapped or dropped criteria', () => {
    expect(changedTaskTerm(listed, {
      ...listed,
      verificationCriteria: { contains_keywords: ['gamma'], pass_threshold: 70 },
    })).toBe('verificationCriteria');
    expect(changedTaskTerm(listed, { ...listed, verificationCriteria: undefined })).toBe('verificationCriteria');
  });

  it('refuses a new brief pointer, public brief, verifier, routing summary or capability set', () => {
    expect(changedTaskTerm(listed, { ...listed, rootHash: '0xABC123' })).toBe('rootHash');
    expect(changedTaskTerm(listed, { ...listed, publicBrief: 'a different task' })).toBe('publicBrief');
    expect(changedTaskTerm(listed, { ...listed, verifierAddress: '0x0000000000000000000000000000000000000002' })).toBe('verifierAddress');
    expect(changedTaskTerm(listed, { ...listed, routingSummary: 'Something else' })).toBe('routingSummary');
    expect(changedTaskTerm(listed, { ...listed, requiredCapabilities: ['research'] })).toBe('requiredCapabilities');
    expect(changedTaskTerm(listed, { ...listed, requiredCapabilities: ['data_processing', 'research', 'translation'] })).toBe('requiredCapabilities');
  });

  it('compares capabilities as a set, so a legacy row stored with repeats re-indexes cleanly', () => {
    expect(changedTaskTerm(
      { ...listed, requiredCapabilities: ['data_processing', 'research', 'research'] },
      { ...listed, requiredCapabilities: ['research', 'data_processing'] },
    )).toBeNull();
  });
});
