import { describe, it, expect } from 'vitest';
import { x25519SharedSecret, x25519KeyPair } from './x25519';

function hex(h: string): Uint8Array {
  return Uint8Array.from(h.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
}
function toHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

describe('x25519', () => {
  it('matches the RFC 7748 test vector', () => {
    const scalar = hex('a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4');
    const u = hex('e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c');
    const out = 'c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552';
    expect(toHex(x25519SharedSecret(scalar, u))).toBe(out);
  });

  it('produces a working ECDH pair (both sides agree)', () => {
    const a = x25519KeyPair();
    const b = x25519KeyPair();
    expect(toHex(x25519SharedSecret(a.secret, b.publicKey))).toBe(
      toHex(x25519SharedSecret(b.secret, a.publicKey)),
    );
  });
});
