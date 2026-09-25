import { afterEach, describe, expect, it } from 'vitest';
import { isWellFormedListing, plainLine } from './untrustedText';

declare global {
  // eslint-disable-next-line no-var
  var __injected: boolean | undefined;
}

// Built from code points so no special character sits in this file's source.
const ch = (code: number) => String.fromCodePoint(code);
const LINE_SEPARATOR = ch(0x2028);
const PARAGRAPH_SEPARATOR = ch(0x2029);
const RIGHT_TO_LEFT_OVERRIDE = ch(0x202e);
const ZERO_WIDTH_SPACE = ch(0x200b);
const NUL = ch(0);

describe('plainLine', () => {
  afterEach(() => { delete globalThis.__injected; });

  // Each name tries to end the `//` comment the generator puts it in.
  it.each([
    ['newline', 'Nice service\nglobalThis.__injected = true; //'],
    ['carriage return', 'Nice service\rglobalThis.__injected = true; //'],
    ['line separator', `Nice service${LINE_SEPARATOR}globalThis.__injected = true; //`],
    ['paragraph separator', `Nice service${PARAGRAPH_SEPARATOR}globalThis.__injected = true; //`],
  ])('keeps a name with a %s on the comment line', (_label, name) => {
    const source = `// BlindMarket — rent ${JSON.stringify(plainLine(name, 200))} (service #1)\nreturn 'ran';`;
    expect(new Function(source)()).toBe('ran');
    expect(globalThis.__injected).toBeUndefined();
  });

  it('removes format characters and backticks, and collapses whitespace', () => {
    expect(plainLine(`a${RIGHT_TO_LEFT_OVERRIDE}b${ZERO_WIDTH_SPACE}c${NUL}d\`e\t\t f`, 100)).toBe("a b c d'e f");
  });

  it('truncates to the limit', () => {
    expect(plainLine('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(plainLine(undefined, 10)).toBe('');
  });
});

describe('isWellFormedListing', () => {
  const ok = {
    id: 7,
    agent_address: '0x' + 'ab'.repeat(20),
    price_raw: '250000',
    agent_public_key: '04' + 'cd'.repeat(64),
  };

  it('accepts a listing as the backend stores it', () => {
    expect(isWellFormedListing(ok)).toBe(true);
    expect(isWellFormedListing({ ...ok, agent_public_key: null })).toBe(true);
    expect(isWellFormedListing({ ...ok, agent_public_key: '' })).toBe(true);
  });

  it.each([
    ['id', { id: 0 }],
    ['id', { id: 1.5 }],
    ['address', { agent_address: "0xab'; process.exit(1); //" }],
    ['price', { price_raw: "1'; fetch('x'); //" }],
    ['public key', { agent_public_key: "04'; require('fs'); //" }],
  ])('refuses a malformed %s', (_label, patch) => {
    expect(isWellFormedListing({ ...ok, ...patch })).toBe(false);
  });
});
