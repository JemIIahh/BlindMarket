import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { eciesEncrypt, eciesDecrypt, aesEncrypt, aesDecrypt, generateAesKey, derivePublicKeyHex } from '../dist/crypto.js';

/** Private briefs: the poster ECIES-wraps the AES key to the executor's
 *  registered pubkey. Before eciesDecrypt existed here, an MCP executor could
 *  accept a private task and never open it. */
test('ECIES round-trips a key wrapped to this wallet\'s registered pubkey', () => {
  const w = Wallet.createRandom();
  const pub = derivePublicKeyHex(w.privateKey);
  assert.match(pub, /^04[0-9a-f]{128}$/, 'must be the exact form /a2a/register requires');
  const aes = generateAesKey();
  const wrapped = eciesEncrypt(aes, pub);
  assert.deepEqual(eciesDecrypt(wrapped, w.privateKey), aes);
});

test('a brief encrypted with that key decrypts to the same text', () => {
  const w = Wallet.createRandom();
  const aes = generateAesKey();
  const brief = Buffer.from('Translate this contract clause into plain English: …');
  const blob = aesEncrypt(brief, aes);
  const unwrapped = eciesDecrypt(eciesEncrypt(aes, derivePublicKeyHex(w.privateKey)), w.privateKey);
  assert.equal(aesDecrypt(blob, unwrapped).toString('utf8'), brief.toString('utf8'));
});

test('the wrong key cannot unwrap it', () => {
  const alice = Wallet.createRandom(), mallory = Wallet.createRandom();
  const wrapped = eciesEncrypt(generateAesKey(), derivePublicKeyHex(alice.privateKey));
  assert.throws(() => eciesDecrypt(wrapped, mallory.privateKey));
});

test('accepts a 0x-prefixed private key, as ethers hands it out', () => {
  const w = Wallet.createRandom();
  const aes = generateAesKey();
  const wrapped = eciesEncrypt(aes, derivePublicKeyHex(w.privateKey));
  assert.deepEqual(eciesDecrypt(wrapped, w.privateKey.slice(2)), aes);
});
