// SSH KEXINIT negotiation, curve25519 key exchange, exchange-hash assembly,
// host-key verification, and key derivation (RFC 4253 §7, §8, §7.2).

import { sha256 } from '@noble/hashes/sha2';
import { SshWriter, SshReader } from './wire';
import { ed25519Verify } from './crypto/ed25519';
import { deriveKey } from './crypto/kdf';
import { SSH_MSG_KEXINIT } from './constants';

/** Client-offered algorithm preferences, most-preferred first. */
export const CLIENT_KEX_ALGORITHMS = ['curve25519-sha256', 'curve25519-sha256@libssh.org'];
export const CLIENT_HOST_KEY_ALGORITHMS = ['ssh-ed25519'];
export const CLIENT_CIPHER_ALGORITHMS = ['aes256-gcm@openssh.com', 'aes128-gcm@openssh.com'];
/** AEAD ciphers (GCM) supply their own integrity check; no separate MAC is negotiated. */
export const CLIENT_MAC_ALGORITHMS: string[] = [];
export const CLIENT_COMPRESSION_ALGORITHMS = ['none'];
const CLIENT_LANGUAGES: string[] = [];

/** Parsed form of a KEXINIT payload (ours or the server's). */
export interface KexInit {
  kex: string[];
  hostKey: string[];
  cipherC2S: string[];
  cipherS2C: string[];
  macC2S: string[];
  macS2C: string[];
  compressionC2S: string[];
  compressionS2C: string[];
  languagesC2S: string[];
  languagesS2C: string[];
}

/**
 * Build the client KEXINIT payload (RFC 4253 §7.1). The returned bytes start
 * with the SSH_MSG_KEXINIT message byte and ARE `I_C` for the exchange hash.
 */
export function buildKexInit(cookie: Uint8Array): Uint8Array {
  if (cookie.length !== 16) {
    throw new Error(`KEXINIT cookie must be 16 bytes, got ${cookie.length}`);
  }
  return new SshWriter()
    .byte(SSH_MSG_KEXINIT)
    .raw(cookie)
    .nameList(CLIENT_KEX_ALGORITHMS)
    .nameList(CLIENT_HOST_KEY_ALGORITHMS)
    .nameList(CLIENT_CIPHER_ALGORITHMS)
    .nameList(CLIENT_CIPHER_ALGORITHMS)
    .nameList(CLIENT_MAC_ALGORITHMS)
    .nameList(CLIENT_MAC_ALGORITHMS)
    .nameList(CLIENT_COMPRESSION_ALGORITHMS)
    .nameList(CLIENT_COMPRESSION_ALGORITHMS)
    .nameList(CLIENT_LANGUAGES)
    .nameList(CLIENT_LANGUAGES)
    .bool(false) // first_kex_packet_follows
    .uint32(0) // reserved
    .finish();
}

/**
 * Parse a KEXINIT payload (RFC 4253 §7.1): message byte + 16-byte cookie,
 * then the 10 name-lists in wire order. The full input bytes ARE `I_S` (or
 * `I_C`, if parsing our own) for the exchange hash.
 */
export function parseKexInit(payload: Uint8Array): KexInit {
  const r = new SshReader(payload);
  const msg = r.byte();
  if (msg !== SSH_MSG_KEXINIT) {
    throw new Error(`Expected SSH_MSG_KEXINIT (20), got ${msg}`);
  }
  r.bytes(16); // cookie, unused here
  return {
    kex: r.nameList(),
    hostKey: r.nameList(),
    cipherC2S: r.nameList(),
    cipherS2C: r.nameList(),
    macC2S: r.nameList(),
    macS2C: r.nameList(),
    compressionC2S: r.nameList(),
    compressionS2C: r.nameList(),
    languagesC2S: r.nameList(),
    languagesS2C: r.nameList(),
    // first_kex_packet_follows + reserved intentionally unread; irrelevant to negotiation.
  };
}

/**
 * Pick the first client-preferred algorithm that also appears in the
 * server's list (RFC 4253 §7.1). Throws if there is no overlap.
 */
export function negotiate(clientPrefs: string[], serverList: string[]): string {
  const serverSet = new Set(serverList);
  for (const name of clientPrefs) {
    if (serverSet.has(name)) return name;
  }
  throw new Error(
    `No mutually supported algorithm: client offered [${clientPrefs.join(', ')}], server offered [${serverList.join(', ')}]`,
  );
}

export interface ExchangeHashInput {
  vClient: Uint8Array;
  vServer: Uint8Array;
  iClient: Uint8Array;
  iServer: Uint8Array;
  kServer: Uint8Array;
  qClient: Uint8Array;
  qServer: Uint8Array;
  /** Raw X25519 shared secret (big-endian magnitude, NOT pre-normalized). */
  sharedSecret: Uint8Array;
}

/**
 * Compute the curve25519-sha256 exchange hash H (RFC 4253 §8 / RFC 8731):
 * H = sha256(string(V_C) || string(V_S) || string(I_C) || string(I_S) ||
 *            string(K_S) || string(Q_C) || string(Q_S) || mpint(K))
 * `.mpint()` normalizes the shared secret; the raw secret must be passed in
 * unnormalized so that normalization happens exactly once, here.
 */
export function computeExchangeHash(input: ExchangeHashInput): Uint8Array {
  const bytes = new SshWriter()
    .string(input.vClient)
    .string(input.vServer)
    .string(input.iClient)
    .string(input.iServer)
    .string(input.kServer)
    .string(input.qClient)
    .string(input.qServer)
    .mpint(input.sharedSecret)
    .finish();
  return sha256(bytes);
}

export interface Ed25519HostKey {
  pub: Uint8Array;
}

/** Parse an ssh-ed25519 host-key blob: string "ssh-ed25519" || string pub(32). */
export function parseHostKeyEd25519(kServer: Uint8Array): Ed25519HostKey {
  const r = new SshReader(kServer);
  const type = new TextDecoder().decode(r.string());
  if (type !== 'ssh-ed25519') {
    throw new Error(`Expected ssh-ed25519 host key, got "${type}"`);
  }
  const pub = r.string();
  if (pub.length !== 32) {
    throw new Error(`ssh-ed25519 public key must be 32 bytes, got ${pub.length}`);
  }
  return { pub };
}

/** Parse an ssh-ed25519 signature blob: string "ssh-ed25519" || string sig(64). */
export function parseSignatureEd25519(sigBlob: Uint8Array): Uint8Array {
  const r = new SshReader(sigBlob);
  const type = new TextDecoder().decode(r.string());
  if (type !== 'ssh-ed25519') {
    throw new Error(`Expected ssh-ed25519 signature, got "${type}"`);
  }
  const sig = r.string();
  if (sig.length !== 64) {
    throw new Error(`ssh-ed25519 signature must be 64 bytes, got ${sig.length}`);
  }
  return sig;
}

/** Verify the server's host-key signature over the exchange hash H. */
export function verifyHostSignature(kServer: Uint8Array, sigBlob: Uint8Array, h: Uint8Array): boolean {
  try {
    const { pub } = parseHostKeyEd25519(kServer);
    const sig = parseSignatureEd25519(sigBlob);
    return ed25519Verify(sig, h, pub);
  } catch {
    return false;
  }
}

export interface SessionKeys {
  ivC2S: Uint8Array;
  ivS2C: Uint8Array;
  keyC2S: Uint8Array;
  keyS2C: Uint8Array;
}

const IV_LEN = 12;
const KEY_LEN = 32; // aes256-gcm; also safe as an upper bound for aes128-gcm callers to slice.

/**
 * Derive the four post-kex secrets (RFC 4253 §7.2). The KDF's `K` input MUST
 * be the mpint-encoded shared secret — the identical bytes used inside
 * `computeExchangeHash`'s `.mpint()` call — not the raw secret.
 */
export function deriveSessionKeys(sharedSecret: Uint8Array, h: Uint8Array, sessionId: Uint8Array): SessionKeys {
  const kMpint = new SshWriter().mpint(sharedSecret).finish();
  return {
    ivC2S: deriveKey(kMpint, h, 'A', sessionId, IV_LEN),
    ivS2C: deriveKey(kMpint, h, 'B', sessionId, IV_LEN),
    keyC2S: deriveKey(kMpint, h, 'C', sessionId, KEY_LEN),
    keyS2C: deriveKey(kMpint, h, 'D', sessionId, KEY_LEN),
  };
}
