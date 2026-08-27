// Parse an unencrypted OpenSSH private key (openssh-key-v1), Ed25519 only.
// Passphrase-encrypted keys (bcrypt-pbkdf) are deferred to a later plan.
import { base64Decode } from '../net/base64';
import { SshReader } from './wire';

const MAGIC = 'openssh-key-v1\0';
const BEGIN_MARKER = '-----BEGIN OPENSSH PRIVATE KEY-----';
const END_MARKER = '-----END OPENSSH PRIVATE KEY-----';

export interface ParsedEd25519Key {
  type: 'ssh-ed25519';
  publicKey: Uint8Array;
  seed: Uint8Array;
}

function extractBase64Body(pem: string): string {
  const beginIdx = pem.indexOf(BEGIN_MARKER);
  const endIdx = pem.indexOf(END_MARKER);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    throw new Error('Not a valid OpenSSH private key: missing BEGIN/END markers.');
  }
  const body = pem.slice(beginIdx + BEGIN_MARKER.length, endIdx);
  return body;
}

export function parseOpenSshPrivateKey(pem: string): ParsedEd25519Key {
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
  let ciphername: string;
  let kdfname: string;
  let numKeys: number;
  let publicKeyBlob: Uint8Array;
  let privateSection: Uint8Array;
  try {
    ciphername = new TextDecoder().decode(reader.string());
    kdfname = new TextDecoder().decode(reader.string());
    reader.string(); // kdfoptions
    numKeys = reader.uint32();
    publicKeyBlob = reader.string();
    privateSection = reader.string();
  } catch (e) {
    throw new Error(`Malformed OpenSSH private key: ${(e as Error).message}`);
  }

  if (ciphername !== 'none' || kdfname !== 'none') {
    throw new Error('Encrypted private keys are not supported yet (use an unencrypted key).');
  }
  if (numKeys !== 1) {
    throw new Error(`Unsupported OpenSSH private key: expected 1 key, found ${numKeys}.`);
  }

  // Parse the public key blob to confirm the key type up front.
  const pubReader = new SshReader(publicKeyBlob);
  const pubKeyType = new TextDecoder().decode(pubReader.string());
  if (pubKeyType !== 'ssh-ed25519') {
    throw new Error(`Unsupported key type "${pubKeyType}": only ssh-ed25519 is supported.`);
  }

  const privReader = new SshReader(privateSection);
  const checkint1 = privReader.uint32();
  const checkint2 = privReader.uint32();
  if (checkint1 !== checkint2) {
    throw new Error('Malformed OpenSSH private key: checkints do not match (corrupt or encrypted key).');
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
