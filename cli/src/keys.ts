import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { Wallet } from 'ethers';
import { configDir, writePrivate } from './config.js';
import { askHidden } from './prompt.js';
import { CliError } from './errors.js';

/**
 * The wallet that signs: the one that owns the API key. The CLI never keeps it
 * in the clear. It comes from BLINDMARKET_PRIVATE_KEY (what the MCP server
 * reads) or from an ethers keystore that `blind login --import-key` wrote,
 * encrypted with a password.
 */

const KEYSTORE = 'keystore.json';
export const keystorePath = () => join(configDir(), KEYSTORE);

export function signingKeySource(): 'env' | 'keystore' | null {
  if (process.env.BLINDMARKET_PRIVATE_KEY) return 'env';
  return existsSync(keystorePath()) ? 'keystore' : null;
}

async function keystorePassword(): Promise<string> {
  return process.env.BLINDMARKET_KEYSTORE_PASSWORD ?? askHidden('Keystore password: ');
}

export async function loadSigner(): Promise<Wallet> {
  const raw = process.env.BLINDMARKET_PRIVATE_KEY;
  if (raw) {
    try {
      return new Wallet(raw.startsWith('0x') ? raw : `0x${raw}`);
    } catch {
      throw new CliError('BAD_PRIVATE_KEY', 'BLINDMARKET_PRIVATE_KEY is not a private key (64 hex characters).');
    }
  }
  if (!existsSync(keystorePath())) {
    throw new CliError(
      'NO_SIGNING_KEY',
      'This needs the wallet that owns your API key to sign. Set BLINDMARKET_PRIVATE_KEY, or run `blind login --import-key` once to store it encrypted.',
    );
  }
  const password = await keystorePassword();
  try {
    const w = await Wallet.fromEncryptedJson(readFileSync(keystorePath(), 'utf-8'), password);
    return new Wallet(w.privateKey);
  } catch {
    throw new CliError('BAD_PASSWORD', `Could not open ${keystorePath()} with that password.`);
  }
}

/** Encrypt `privateKey` with a password (asked twice, or BLINDMARKET_KEYSTORE_PASSWORD) and store it. */
export async function saveKeystore(privateKey: string): Promise<void> {
  let password = process.env.BLINDMARKET_KEYSTORE_PASSWORD;
  if (!password) {
    password = await askHidden('Choose a keystore password: ');
    if (password.length < 8) throw new CliError('WEAK_PASSWORD', 'Use a password of at least 8 characters.');
    if ((await askHidden('Repeat it: ')) !== password) throw new CliError('PASSWORD_MISMATCH', 'The passwords did not match. Nothing was saved.');
  }
  writePrivate(KEYSTORE, await new Wallet(privateKey).encrypt(password));
}

/** Uncompressed secp256k1 public key, hex without 0x: what the backend encrypts to. */
export function publicKeyHex(w: Wallet): string {
  return w.signingKey.publicKey.slice(2);
}
