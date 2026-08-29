// Parse an OpenSSH private key (openssh-key-v1), Ed25519 only.
// Supports unencrypted keys and passphrase-encrypted keys using the bcrypt
// KDF with aes-ctr / aes-cbc / aes-gcm ciphers.
import { base64Decode } from '../net/base64';
import { SshReader } from './wire';
import { bcryptPbkdf } from './crypto/bcrypt_pbkdf';
import { ctr, cbc, gcm } from '@noble/ciphers/aes';

const MAGIC = 'openssh-key-v1\0';
const BEGIN_MARKER = '-----BEGIN OPENSSH PRIVATE KEY-----';
const END_MARKER = '-----END OPENSSH PRIVATE KEY-----';

export interface ParsedEd25519Key {
  type: 'ssh-ed25519';
  publicKey: Uint8Array;
  seed: Uint8Array;
}

/**
 * Thrown when an encrypted OpenSSH private key is parsed without a passphrase.
 * Lets the UI branch on `err instanceof EncryptedKeyError` to prompt for one.
 */
export class EncryptedKeyError extends Error {
  constructor(message = 'This private key is encrypted; a passphrase is required.') {
    super(message);
    this.name = 'EncryptedKeyError';
  }
}

interface CipherSpec {
  keyLen: number;
  ivLen: number;
  mode: 'ctr' | 'cbc' | 'gcm';
}

// Cipher parameters used both to size the derived key||IV and to decrypt.
const CIPHERS: Record<string, CipherSpec> = {
  'aes256-ctr': { keyLen: 32, ivLen: 16, mode: 'ctr' },
  'aes192-ctr': { keyLen: 24, ivLen: 16, mode: 'ctr' },
  'aes128-ctr': { keyLen: 16, ivLen: 16, mode: 'ctr' },
  'aes256-cbc': { keyLen: 32, ivLen: 16, mode: 'cbc' },
  'aes192-cbc': { keyLen: 24, ivLen: 16, mode: 'cbc' },
  'aes128-cbc': { keyLen: 16, ivLen: 16, mode: 'cbc' },
  // GCM in OpenSSH private keys derives a 12-byte IV; the 16-byte auth tag is
  // appended to the ciphertext, and the AAD is empty.
  'aes256-gcm@openssh.com': { keyLen: 32, ivLen: 12, mode: 'gcm' },
  'aes128-gcm@openssh.com': { keyLen: 16, ivLen: 12, mode: 'gcm' },
};

function extractBase64Body(pem: string): string {
  const beginIdx = pem.indexOf(BEGIN_MARKER);
  const endIdx = pem.indexOf(END_MARKER);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    throw new Error('Not a valid OpenSSH private key: missing BEGIN/END markers.');
  }
  const body = pem.slice(beginIdx + BEGIN_MARKER.length, endIdx);
  return body;
}

// Decode the outer openssh-key-v1 envelope, returning its header fields plus the
// still-possibly-encrypted private section.
function decodeEnvelope(pem: string): {
  ciphername: string;
  kdfname: string;
  kdfoptions: Uint8Array;
  numKeys: number;
  publicKeyBlob: Uint8Array;
  privateSection: Uint8Array;
  trailer: Uint8Array;
} {
  const b64 = extractBase64Body(pem);
  const blob = base64Decode(b64);
  if (blob.length === 0) {
    throw new Error('Malformed OpenSSH private key: empty or invalid base64 body.');
  }

  const magicBytes = new TextEncoder().encode(MAGIC);
  if (blob.length < magicBytes.length) {
    throw new Error('Malformed OpenSSH private key: too short.');
  }
  for (let i = 0; i < magicBytes.length; i++) {
    if (blob[i] !== magicBytes[i]) {
      throw new Error('Malformed OpenSSH private key: bad magic header.');
    }
  }

  const reader = new SshReader(blob.subarray(magicBytes.length));
  try {
    const ciphername = new TextDecoder().decode(reader.string());
    const kdfname = new TextDecoder().decode(reader.string());
    const kdfoptions = reader.string();
    const numKeys = reader.uint32();
    const publicKeyBlob = reader.string();
    const privateSection = reader.string();
    // For AEAD ciphers (aes-gcm), the auth tag is appended after the encrypted
    // string field rather than inside it. Capture whatever trails the section.
    const trailer = reader.remaining();
    return { ciphername, kdfname, kdfoptions, numKeys, publicKeyBlob, privateSection, trailer };
  } catch (e) {
    throw new Error(`Malformed OpenSSH private key: ${(e as Error).message}`);
  }
}

/** Returns true if the PEM is an OpenSSH private key protected by a passphrase. */
export function isEncryptedOpenSshKey(pem: string): boolean {
  try {
    const { ciphername, kdfname } = decodeEnvelope(pem);
    return ciphername !== 'none' || kdfname !== 'none';
  } catch {
    return false;
  }
}

// Derive the key/IV and decrypt the private section of an encrypted key.
function decryptPrivateSection(
  ciphername: string,
  kdfname: string,
  kdfoptions: Uint8Array,
  encrypted: Uint8Array,
  trailer: Uint8Array,
  passphrase: string,
): Uint8Array {
  const spec = CIPHERS[ciphername];
  if (!spec) {
    throw new Error(`Unsupported cipher "${ciphername}" for the encrypted private key.`);
  }
  if (kdfname !== 'bcrypt') {
    throw new Error(`Unsupported KDF "${kdfname}" for the encrypted private key.`);
  }

  const kdfReader = new SshReader(kdfoptions);
  let salt: Uint8Array;
  let rounds: number;
  try {
    salt = kdfReader.string();
    rounds = kdfReader.uint32();
  } catch (e) {
    throw new Error(`Malformed bcrypt KDF options: ${(e as Error).message}`);
  }

  const passBytes = new TextEncoder().encode(passphrase);
  const derived = bcryptPbkdf(passBytes, salt, rounds, spec.keyLen + spec.ivLen);
  const key = derived.subarray(0, spec.keyLen);
  const iv = derived.subarray(spec.keyLen, spec.keyLen + spec.ivLen);

  if (spec.mode === 'ctr') {
    // AES-CTR: length-preserving; the whole blob is ciphertext.
    return ctr(key, iv).decrypt(encrypted);
  }
  if (spec.mode === 'cbc') {
    if (encrypted.length % 16 !== 0) {
      throw new Error('Malformed encrypted private key: CBC length not a block multiple.');
    }
    // OpenSSH pads to the block size itself; there is no PKCS#7 trailer.
    return cbc(key, iv, { disablePadding: true }).decrypt(encrypted);
  }
  // GCM: the 16-byte auth tag trails the encrypted string field; AAD is empty.
  // noble expects ciphertext||tag, so re-join them. A wrong passphrase corrupts
  // the key and the tag check fails, so surface that as a passphrase error.
  if (trailer.length !== 16) {
    throw new Error('Malformed encrypted private key: missing GCM authentication tag.');
  }
  const ctAndTag = new Uint8Array(encrypted.length + trailer.length);
  ctAndTag.set(encrypted, 0);
  ctAndTag.set(trailer, encrypted.length);
  try {
    return gcm(key, iv, new Uint8Array(0)).decrypt(ctAndTag);
  } catch {
    throw new Error('Incorrect passphrase for the private key.');
  }
}

export function parseOpenSshPrivateKey(pem: string, passphrase?: string): ParsedEd25519Key {
  const { ciphername, kdfname, kdfoptions, numKeys, publicKeyBlob, privateSection, trailer } =
    decodeEnvelope(pem);

  if (numKeys !== 1) {
    throw new Error(`Unsupported OpenSSH private key: expected 1 key, found ${numKeys}.`);
  }

  // Parse the public key blob to confirm the key type up front.
  const pubReader = new SshReader(publicKeyBlob);
  const pubKeyType = new TextDecoder().decode(pubReader.string());
  if (pubKeyType !== 'ssh-ed25519') {
    throw new Error(`Unsupported key type "${pubKeyType}": only ssh-ed25519 is supported.`);
  }

  const encrypted = ciphername !== 'none' || kdfname !== 'none';

  let privateSectionPlain: Uint8Array;
  if (encrypted) {
    if (!passphrase) {
      throw new EncryptedKeyError();
    }
    privateSectionPlain = decryptPrivateSection(
      ciphername,
      kdfname,
      kdfoptions,
      privateSection,
      trailer,
      passphrase,
    );
  } else {
    privateSectionPlain = privateSection;
  }

  const privReader = new SshReader(privateSectionPlain);
  const checkint1 = privReader.uint32();
  const checkint2 = privReader.uint32();
  if (checkint1 !== checkint2) {
    if (encrypted) {
      throw new Error('Incorrect passphrase for the private key.');
    }
    throw new Error('Malformed OpenSSH private key: checkints do not match (corrupt key).');
  }

  const keyType = new TextDecoder().decode(privReader.string());
  if (keyType !== 'ssh-ed25519') {
    throw new Error(`Unsupported key type "${keyType}": only ssh-ed25519 is supported.`);
  }

  const publicKey = privReader.string();
  const priv = privReader.string();
  // comment and padding follow; not needed.

  if (publicKey.length !== 32) {
    throw new Error(`Malformed ssh-ed25519 key: expected 32-byte public key, got ${publicKey.length}.`);
  }
  if (priv.length !== 64) {
    throw new Error(`Malformed ssh-ed25519 key: expected 64-byte private field, got ${priv.length}.`);
  }

  const seed = priv.slice(0, 32);

  return { type: 'ssh-ed25519', publicKey, seed };
}
