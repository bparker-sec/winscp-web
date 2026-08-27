import { ed25519 } from '@noble/curves/ed25519';

/** Verify an Ed25519 signature. Never throws (malformed input → false). */
export function ed25519Verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}
