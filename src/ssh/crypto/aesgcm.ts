import { gcm } from '@noble/ciphers/aes';

/** AES-GCM seal: returns ciphertext||tag (16-byte tag appended by noble). */
export function gcmSeal(key: Uint8Array, iv: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
  return gcm(key, iv, aad).encrypt(plaintext);
}

/** AES-GCM open: verifies the tag and returns plaintext, or throws on mismatch. */
export function gcmOpen(key: Uint8Array, iv: Uint8Array, aad: Uint8Array, ciphertextAndTag: Uint8Array): Uint8Array {
  return gcm(key, iv, aad).decrypt(ciphertextAndTag);
}

/**
 * Increment the SSH GCM IV in place: the IV is fixed(4) || counter(8); only the
 * trailing 8-byte counter is incremented, big-endian, per RFC 5647.
 */
export function incrementGcmIv(iv: Uint8Array): void {
  for (let i = iv.length - 1; i >= 4; i--) {
    iv[i] = (iv[i] + 1) & 0xff;
    if (iv[i] !== 0) break;
  }
}
