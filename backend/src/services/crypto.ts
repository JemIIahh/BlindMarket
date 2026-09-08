import { randomBytes, createCipheriv, createDecipheriv, createHash, createECDH, hkdfSync, generateKeyPairSync, diffieHellman, createPrivateKey, createPublicKey } from 'crypto';
import { ed25519 } from '@noble/curves/ed25519.js';

const edwardsToMontgomeryPub = ed25519.utils.toMontgomery;
const edwardsToMontgomeryPriv = ed25519.utils.toMontgomerySecret;

/**
 * Encryption utilities for BlindMarket.
 *
 * The backend NEVER decrypts task content or evidence.
 * These utilities exist so the SDK/frontend can:
 *   1. Encrypt blobs with AES-256-GCM before uploading
 *   2. Wrap AES keys with ECIES for key exchange
 *   3. Generate keypairs (ECDH on secp256k1)
 *
 * Flow:
 *   Agent creates task:
 *     - Generate AES key → encrypt instructions → upload to 0G
 *     - ECIES-wrap AES key to agent's own pubkey (self-backup)
 *
 *   Agent assigns worker:
 *     - ECIES-wrap same AES key to worker's pubkey → send wrapped key
 *
 *   Worker submits evidence:
 *     - Generate new AES key → encrypt evidence → upload to 0G
 *     - ECIES-wrap to enclave pubkey (for Sealed Inference)
 *     - ECIES-wrap to agent pubkey (for agent review)
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;     // GCM standard
const TAG_LENGTH = 16;    // GCM auth tag
const KEY_LENGTH = 32;    // AES-256
const ECIES_PUBKEY_LENGTH = 65; // uncompressed secp256k1
const X25519_PUBKEY_LENGTH = 32; // X25519 (Ed25519-derived)
const ECIES_MIN_BLOB = ECIES_PUBKEY_LENGTH + IV_LENGTH + TAG_LENGTH + 1; // 94 bytes minimum
const X25519_MIN_BLOB = X25519_PUBKEY_LENGTH + IV_LENGTH + TAG_LENGTH + 1; // 61 bytes minimum
const AES_MIN_BLOB = IV_LENGTH + TAG_LENGTH + 1; // 29 bytes minimum

// Domain separation string for ECIES key derivation (prevents cross-protocol reuse)
const ECIES_HKDF_INFO = 'BlindMarket-ECIES-v1';
const ECIES_X25519_HKDF_INFO = 'BlindMarket-ECIES-X25519-v1';

// ── Helpers for Tool Header Encryption ──

/** 
 * Encrypt a sensitive header value using the agent's private key.
 * Derives a deterministic symmetric key from the private key.
 */
export function encryptSensitive(value: string, agentPrivateKey: string): string {
  const key = createHash('sha256').update(agentPrivateKey).digest();
  return aesEncrypt(Buffer.from(value), key).toString('hex');
}

/** 
 * Decrypt a sensitive header value using the agent's private key.
 */
export function decryptSensitive(encryptedHex: string, agentPrivateKey: string): string {
  const key = createHash('sha256').update(agentPrivateKey).digest();
  return aesDecrypt(Buffer.from(encryptedHex, 'hex'), key).toString();
}

// ── AES-256-GCM (symmetric) ──

/** Encrypt plaintext with AES-256-GCM. Returns iv + tag + ciphertext concatenated. */
export function aesEncrypt(plaintext: Buffer, key: Buffer): Buffer {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`AES key must be exactly ${KEY_LENGTH} bytes, got ${key.length}`);
  }
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: [12 bytes IV][16 bytes tag][ciphertext]
  return Buffer.concat([iv, tag, encrypted]);
}

/** Decrypt AES-256-GCM blob. Input format: [12 IV][16 tag][ciphertext]. */
export function aesDecrypt(blob: Buffer, key: Buffer): Buffer {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`AES key must be exactly ${KEY_LENGTH} bytes, got ${key.length}`);
  }
  if (blob.length < AES_MIN_BLOB) {
    throw new Error(`AES blob too short: need at least ${AES_MIN_BLOB} bytes, got ${blob.length}`);
  }
  const iv = blob.subarray(0, IV_LENGTH);
  const tag = blob.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = blob.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Generate a random AES-256 key */
export function generateAesKey(): Buffer {
  return randomBytes(KEY_LENGTH);
}

// ── ECIES (asymmetric key wrapping via ECDH + HKDF + AES) ──

/** Generate a secp256k1 keypair. Returns { privateKey, publicKey } as hex strings. */
export function generateKeyPair(): { privateKey: string; publicKey: string } {
  const ecdh = createECDH('secp256k1');
  ecdh.generateKeys();
  return {
    privateKey: ecdh.getPrivateKey('hex'),
    publicKey: ecdh.getPublicKey('hex', 'uncompressed'),
  };
}

/**
 * ECIES encrypt: wrap data to a recipient's public key.
 *
 * 1. Generate ephemeral keypair
 * 2. ECDH shared secret with recipient's pubkey
 * 3. Derive AES key via HKDF-SHA256 with domain separation
 * 4. AES-256-GCM encrypt the data
 * 5. Return ephemeralPubKey + encrypted blob
 *
 * Auto-detects key type: 65-byte secp256k1 or 32-byte Ed25519 (X25519).
 */
export function eciesEncrypt(data: Buffer, recipientPubKeyHex: string): Buffer {
  const cleanKey = recipientPubKeyHex.startsWith('0x') ? recipientPubKeyHex.slice(2) : recipientPubKeyHex;

  const keyBytes = Buffer.from(cleanKey, 'hex');

  if (keyBytes.length === X25519_PUBKEY_LENGTH) {
    // Ed25519 public key → convert to X25519 for ECDH
    return eciesEncryptX25519(data, keyBytes);
  }

  // Default: secp256k1
  try {
    let normKey = cleanKey;
    if (cleanKey.length === 68 && cleanKey.startsWith('01')) {
      normKey = cleanKey.slice(2);
    }
    return eciesEncryptSecp256k1(data, normKey);
  } catch (err) {
    // Fail CLOSED. A recipient key that passes length checks but fails ECDH
    // (e.g. off-curve) must surface HERE — returning an empty buffer let callers
    // store a wrappedKey of '' with a 200, leaving the brief/evidence permanently
    // undecryptable and (via deploy) locking the agent's own private key. The SDK
    // twin (sdk/src/crypto/ecies.ts) already throws; match it.
    throw new Error(`ECIES encryption failed for recipient pubkey (len ${cleanKey.length}): ${(err as Error).message}`);
  }
}

/**
 * ECIES decrypt: unwrap data with recipient's private key.
 *
 * Auto-detects curve from ephemeral public key length in the blob.
 */
export function eciesDecrypt(blob: Buffer, recipientPrivKeyHex: string): Buffer {
  if (blob.length === 0) {
    return Buffer.alloc(0);
  }
  if (blob.length >= X25519_MIN_BLOB && blob.length < ECIES_MIN_BLOB) {
    return eciesDecryptX25519(blob, recipientPrivKeyHex);
  }
  return eciesDecryptSecp256k1(blob, recipientPrivKeyHex);
}

function eciesEncryptSecp256k1(data: Buffer, recipientPubKeyHex: string): Buffer {
  const ephemeral = createECDH('secp256k1');
  ephemeral.generateKeys();

  const sharedSecret = ephemeral.computeSecret(Buffer.from(recipientPubKeyHex, 'hex'));
  const derivedKey = Buffer.from(hkdfSync('sha256', sharedSecret, '', ECIES_HKDF_INFO, KEY_LENGTH));

  const encrypted = aesEncrypt(data, derivedKey);
  const ephemeralPub = ephemeral.getPublicKey();

  // Format: [65 bytes uncompressed ephemeral pubkey][encrypted blob]
  return Buffer.concat([ephemeralPub, encrypted]);
}

function eciesDecryptSecp256k1(blob: Buffer, recipientPrivKeyHex: string): Buffer {
  if (blob.length < ECIES_MIN_BLOB) {
    throw new Error(`ECIES blob too short: need at least ${ECIES_MIN_BLOB} bytes, got ${blob.length}`);
  }

  const ephemeralPub = blob.subarray(0, ECIES_PUBKEY_LENGTH);
  const encrypted = blob.subarray(ECIES_PUBKEY_LENGTH);

  const ecdh = createECDH('secp256k1');
  ecdh.setPrivateKey(Buffer.from(recipientPrivKeyHex, 'hex'));

  const sharedSecret = ecdh.computeSecret(ephemeralPub);
  const derivedKey = Buffer.from(hkdfSync('sha256', sharedSecret, '', ECIES_HKDF_INFO, KEY_LENGTH));

  return aesDecrypt(encrypted, derivedKey);
}

/**
 * Ed25519/X25519 ECIES: encrypt data to an Ed25519 public key.
 *
 * 1. Convert Ed25519 pubkey → X25519 pubkey
 * 2. Generate ephemeral X25519 keypair
 * 3. X25519 ECDH shared secret
 * 4. HKDF-SHA256 → AES key
 * 5. AES-256-GCM encrypt
 * 6. Return [32 bytes ephemeral X25519 pubkey][encrypted blob]
 */
/** DER prefixes for wrapping a raw 32-byte X25519 key as SPKI / PKCS#8.
 *  OID 1.3.101.110 (2b656e) is X25519; 1.3.101.112 (2b6570) is Ed25519 — the
 *  decrypt path used the Ed25519 OID against an X25519 key, which is why
 *  createPrivateKey threw "not enough data" on every attempt. */
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

const x25519PublicFromRaw = (raw: Buffer) =>
  createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });

function eciesEncryptX25519(data: Buffer, ed25519PubKey: Buffer): Buffer {
  const x25519PubKey = edwardsToMontgomeryPub(ed25519PubKey);
  const eph = generateKeyPairSync('x25519');
  const ephPubRaw = eph.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);

  // ECDH against the RECIPIENT's key. This previously read
  // `publicKey: eph.publicKey` — a Diffie-Hellman of the ephemeral keypair
  // with itself, so the recipient never entered the shared secret and the
  // blob was not encrypted to them at all. The decrypt side made the mirror
  // mistake, so the two never agreed and nothing sealed this way could be
  // opened. Latent rather than live: every registered agent uses a 65-byte
  // secp256k1 key, and only a 32-byte Ed25519 key reaches this branch.
  const sharedSecret = diffieHellman({
    privateKey: eph.privateKey,
    publicKey: x25519PublicFromRaw(Buffer.from(x25519PubKey)),
  });
  const derivedKey = Buffer.from(hkdfSync('sha256', sharedSecret, '', ECIES_X25519_HKDF_INFO, KEY_LENGTH));

  const encrypted = aesEncrypt(data, derivedKey);

  // Format: [32 bytes ephemeral X25519 pubkey][encrypted blob]
  return Buffer.concat([ephPubRaw, encrypted]);
}

/**
 * Ed25519/X25519 ECIES: decrypt data with an Ed25519 private key.
 *
 * 1. Convert Ed25519 privkey → X25519 privkey
 * 2. Extract ephemeral X25519 pubkey (first 32 bytes)
 * 3. X25519 ECDH
 * 4. HKDF-SHA256 → AES key
 * 5. AES-256-GCM decrypt
 */
function eciesDecryptX25519(blob: Buffer, ed25519PrivKeyHex: string): Buffer {
  if (blob.length < X25519_MIN_BLOB) {
    throw new Error(`X25519 ECIES blob too short: need at least ${X25519_MIN_BLOB} bytes, got ${blob.length}`);
  }

  const ephemeralPub = blob.subarray(0, X25519_PUBKEY_LENGTH);
  const encrypted = blob.subarray(X25519_PUBKEY_LENGTH);

  // Convert Ed25519 private key to X25519
  const ed25519PrivBytes = Buffer.from(ed25519PrivKeyHex, 'hex');
  const x25519PrivKey = edwardsToMontgomeryPriv(ed25519PrivBytes);

  // Build X25519 private key object. The OID here was 2b6570 (Ed25519) with a
  // length header one byte short — an X25519 key described as an Ed25519 one.
  const privKeyObj = createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, Buffer.from(x25519PrivKey)]),
    format: 'der',
    type: 'pkcs8',
  });

  // ECDH against the EPHEMERAL key carried in the blob — previously this
  // derived the recipient's own public key and did DH with itself, so the
  // sender's ephemeral key never entered the secret.
  const sharedSecret = diffieHellman({
    privateKey: privKeyObj,
    publicKey: x25519PublicFromRaw(Buffer.from(ephemeralPub)),
  });
  const derivedKey = Buffer.from(hkdfSync('sha256', sharedSecret, '', ECIES_X25519_HKDF_INFO, KEY_LENGTH));

  return aesDecrypt(encrypted, derivedKey);
}

/** SHA-256 hash of data, returned as hex string (for on-chain taskHash/evidenceHash) */
export function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Generate a random nonce (hex string) */
export function generateNonce(): string {
  return randomBytes(32).toString('hex');
}
