import { x25519 } from '@noble/curves/ed25519';

export interface X25519KeyPair {
  secret: Uint8Array; // 32 bytes
  publicKey: Uint8Array; // 32 bytes
}

export function x25519KeyPair(): X25519KeyPair {
  const secret = x25519.utils.randomPrivateKey();
  return { secret, publicKey: x25519.getPublicKey(secret) };
}

export function x25519SharedSecret(secret: Uint8Array, peerPublic: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(secret, peerPublic);
}
