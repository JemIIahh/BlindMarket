import { describe, expect, it } from 'vitest';
import { briefPreview, normalizeBrief, splitBrief } from './briefText';

// Built from code points so no special character sits in this file's source.
const ch = (code: number) => String.fromCodePoint(code);
const LINE_SEPARATOR = ch(0x2028);
const PARAGRAPH_SEPARATOR = ch(0x2029);
const RIGHT_TO_LEFT_OVERRIDE = ch(0x202e);
const ZERO_WIDTH_SPACE = ch(0x200b);
const ZERO_WIDTH_JOINER = ch(0x200d);
const ZERO_WIDTH_NON_JOINER = ch(0x200c);
const NUL = ch(0);
// The two characters backslash + n, as double-encoded briefs carry them.
const BS_N = '\\n';

describe('normalizeBrief', () => {
  it('turns line breaks written as text into real ones', () => {
    expect(normalizeBrief(`Top Memecoins by Volume${BS_N}${BS_N}List the 10 memecoins.`))
      .toBe('Top Memecoins by Volume\n\nList the 10 memecoins.');
  });

  it('handles a brief that mixes written and real line breaks (seen on prod)', () => {
    expect(normalizeBrief(`TEE vs ZK vs FHE${BS_N}${BS_N}Compare them in one table.\n\nmin_length: 300`))
      .toBe('TEE vs ZK vs FHE\n\nCompare them in one table.\n\nmin_length: 300');
  });

  it('leaves a backslash-n inside a code span alone', () => {
    expect(normalizeBrief(`Split lines on \`${BS_N}\`, then count them`))
      .toBe(`Split lines on \`${BS_N}\`, then count them`);
    expect(normalizeBrief(`Fix it${BS_N}\`\`\`\nprint("a${BS_N}b")\n\`\`\``))
      .toBe(`Fix it\n\`\`\`\nprint("a${BS_N}b")\n\`\`\``);
  });

  it('unwraps a JSON string pasted with its quotes and trailing comma (seen on prod)', () => {
    expect(normalizeBrief(`"Explain BlindMarket${BS_N}${BS_N}Context: agents hire agents.",`))
      .toBe('Explain BlindMarket\n\nContext: agents hire agents.');
    expect(normalizeBrief('"Say \\"hi\\" to the team"')).toBe('Say "hi" to the team');
  });

  it('drops the quotes of a pasted string that is not valid JSON', () => {
    expect(normalizeBrief('"Say "hi"\nto the team",')).toBe('Say "hi"\nto the team');
  });

  it('keeps a title that only starts with a quote', () => {
    expect(normalizeBrief(`"Buy the dip" explained${BS_N}Body`)).toBe('"Buy the dip" explained\nBody');
  });

  it('removes hidden characters and keeps tabs', () => {
    expect(normalizeBrief(`a${RIGHT_TO_LEFT_OVERRIDE}b${ZERO_WIDTH_SPACE}c${NUL}d\te`)).toBe('abcd\te');
  });

  it('keeps the joiners that emoji sequences and Persian or Indic text need', () => {
    const technologist = `${ch(0x1f469)}${ZERO_WIDTH_JOINER}${ch(0x1f4bb)}`;
    expect(normalizeBrief(`Build ${technologist} tools`)).toBe(`Build ${technologist} tools`);
    const persian = `${ch(0x0645)}${ch(0x06cc)}${ZERO_WIDTH_NON_JOINER}${ch(0x062e)}${ch(0x0648)}${ch(0x0627)}${ch(0x0645)}`;
    expect(normalizeBrief(persian)).toBe(persian);
  });

  it('normalises other line endings, trims lines and collapses blank runs', () => {
    expect(normalizeBrief(`a\r\nb\rc${LINE_SEPARATOR}d${PARAGRAPH_SEPARATOR}e`)).toBe('a\nb\nc\nd\ne');
    expect(normalizeBrief('  one   \n\n\n\n two  ')).toBe('one\n\n two');
  });

  it('returns an empty string for no brief', () => {
    expect(normalizeBrief(undefined)).toBe('');
    expect(normalizeBrief(null)).toBe('');
    expect(normalizeBrief('   ')).toBe('');
  });
});

describe('splitBrief', () => {
  it('uses the first line as the title', () => {
    expect(splitBrief(`4-Panel Comic Script${BS_N}${BS_N}Write a 4-panel comic script.`)).toEqual({
      title: '4-Panel Comic Script',
      body: 'Write a 4-panel comic script.',
    });
  });

  it('strips a markdown heading, a "Title:" label and bold marks', () => {
    expect(splitBrief('## Weekly report\nBody').title).toBe('Weekly report');
    expect(splitBrief('Title: Weekly report\nBody').title).toBe('Weekly report');
    expect(splitBrief('**Weekly report**\nBody').title).toBe('Weekly report');
  });

  it('skips leading blank lines', () => {
    expect(splitBrief('\n\n  \nReal title\nBody')).toEqual({ title: 'Real title', body: 'Body' });
  });

  it('takes the first sentence of a brief that is one long paragraph', () => {
    const para = 'Summarize the attached quarterly report for a board audience. '
      + 'Keep it under 200 words and list three risks with one mitigation each.';
    expect(splitBrief(para)).toEqual({
      title: 'Summarize the attached quarterly report for a board audience',
      body: 'Keep it under 200 words and list three risks with one mitigation each.',
    });
  });

  it('keeps a short one-line summary whole, without its full stop', () => {
    expect(splitBrief('Write 10 launch tweets for a new AI agent marketplace.')).toEqual({
      title: 'Write 10 launch tweets for a new AI agent marketplace',
      body: '',
    });
    expect(splitBrief('Wait for it...').title).toBe('Wait for it...');
  });

  it('returns empty parts for no brief', () => {
    expect(splitBrief(undefined)).toEqual({ title: '', body: '' });
  });
});

describe('briefPreview', () => {
  it('drops the setting lines posters type at the end (seen on prod)', () => {
    expect(briefPreview('Compare them in one table.\n\nmin_length: 300')).toBe('Compare them in one table.');
    expect(briefPreview('Write 5 questions.\n\nmin-length: 150')).toBe('Write 5 questions.');
    expect(briefPreview('Backtest it.\n\nmin_length": 1000')).toBe('Backtest it.');
    expect(briefPreview('Explain it.\nmax_words = 400\n')).toBe('Explain it.');
  });

  it('keeps a setting-like line that is not at the end', () => {
    expect(briefPreview('min_length: 300\nThen explain.')).toBe('min_length: 300 Then explain.');
  });

  it('removes markdown marks and joins lines', () => {
    expect(briefPreview('## Goal\n- **Find** the [docs](https://x.y)\n- Run `npm test`\n> note'))
      .toBe('Goal Find the docs Run npm test note');
  });
});
