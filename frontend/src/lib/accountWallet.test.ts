import { describe, it, expect } from 'vitest';
import { unlinkedSignerError } from './accountWallet';

// The addresses from the 2026-09-24 incident: MetaMask signed as 0xB370…,
// the page (and the account) knew 0xd6C4… and 0xBb80….
const EMBEDDED = '0xd6C4EdE07DBbB630841df7385180c1192e707bE6';
const LINKED = '0xBb8021Dc9a063F4F2525f532fAA3FE1907599026';
const STRAY = '0xB3704310E72538342B0CB28EE41D62e77d64f7be';

describe('unlinkedSignerError', () => {
  it('lets a wallet on the account pay, whatever its case', () => {
    expect(unlinkedSignerError(EMBEDDED, [EMBEDDED, LINKED], 'x')).toBeNull();
    expect(unlinkedSignerError(LINKED.toLowerCase(), [EMBEDDED, LINKED], 'x')).toBeNull();
    expect(unlinkedSignerError(LINKED, [EMBEDDED.toLowerCase(), LINKED.toLowerCase()], 'x')).toBeNull();
  });

  it('refuses a wallet that is not on the account, before anything is spent, and says what to do', () => {
    const msg = unlinkedSignerError(STRAY, [EMBEDDED, LINKED], 'the task could not be listed');
    expect(msg).toContain('0xb370…f7be');
    expect(msg).toContain('the task could not be listed');
    expect(msg).toContain('Nothing was spent');
    expect(msg).toContain('0xd6c4…7be6 or 0xbb80…9026');
    expect(msg).toContain('Settings → Link wallet');
  });

  it('does not block while the account wallets are unknown', () => {
    expect(unlinkedSignerError(STRAY, [], 'x')).toBeNull();
    expect(unlinkedSignerError(STRAY, [null, undefined], 'x')).toBeNull();
  });

  it('lists each account wallet once', () => {
    const msg = unlinkedSignerError(STRAY, [EMBEDDED, EMBEDDED.toLowerCase(), null], 'x')!;
    expect(msg.match(/0xd6c4…7be6/g)).toHaveLength(1);
  });
});
