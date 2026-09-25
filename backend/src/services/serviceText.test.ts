import { describe, expect, it } from 'vitest';
import { serviceDescription, serviceName } from './serviceText.js';

// Built from code points so no special character sits in this file's source.
const ch = (code: number) => String.fromCodePoint(code);
const LINE_SEPARATOR = ch(0x2028);
const PARAGRAPH_SEPARATOR = ch(0x2029);
const RIGHT_TO_LEFT_OVERRIDE = ch(0x202e);
const FIRST_STRONG_ISOLATE = ch(0x2068);
const ZERO_WIDTH_JOINER = ch(0x200d);
const NUL = ch(0);

describe('serviceName', () => {
  it('accepts ordinary names, including emoji sequences', () => {
    expect(serviceName.safeParse('PDF Summarizer').success).toBe(true);
    expect(serviceName.safeParse(`Dev ${ch(0x1f468)}${ZERO_WIDTH_JOINER}${ch(0x1f4bb)} helper`).success).toBe(true);
  });

  it.each([
    ['a newline', 'Nice name\nconsole.log(1)'],
    ['a carriage return', 'Nice name\rmore'],
    ['a line separator', `Nice name${LINE_SEPARATOR}more`],
    ['a paragraph separator', `Nice name${PARAGRAPH_SEPARATOR}more`],
    ['a bidi override', `Nice name${RIGHT_TO_LEFT_OVERRIDE}more`],
    ['a NUL', `Nice name${NUL}more`],
  ])('refuses a name with %s', (_label, name) => {
    expect(serviceName.safeParse(name).success).toBe(false);
  });
});

describe('serviceDescription', () => {
  it('keeps line breaks and tabs', () => {
    expect(serviceDescription.safeParse('Line one.\nLine two.\tTabbed.\r\nWindows line.').success).toBe(true);
  });

  it.each([
    ['a line separator', `one${LINE_SEPARATOR}two`],
    ['a paragraph separator', `one${PARAGRAPH_SEPARATOR}two`],
    ['a bidi isolate', `one${FIRST_STRONG_ISOLATE}two`],
    ['a NUL', `one${NUL}two`],
  ])('refuses a description with %s', (_label, text) => {
    expect(serviceDescription.safeParse(text).success).toBe(false);
  });
});
