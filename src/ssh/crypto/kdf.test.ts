import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha2';
import { concatBytes } from '@noble/hashes/utils';
import { deriveKey } from './kdf';

describe('deriveKey (RFC 4253 §7.2)', () => {
  const K = Uint8Array.of(0, 0, 0, 3, 1, 2, 3); // pretend mpint
  const H = new TextEncoder().encode('exchange-hash-32-bytes-padding!!');
  const sid = H;

  it('single block for needed <= hash size', () => {
    const expected = sha256(concatBytes(K, H, Uint8Array.of(0x41 /* 'A' */), sid));
    expect(Array.from(deriveKey(K, H, 'A', sid, 32))).toEqual(Array.from(expected));
  });

  it('extends across blocks for needed > hash size', () => {
    const k1 = sha256(concatBytes(K, H, Uint8Array.of(0x43 /* 'C' */), sid));
    const k2 = sha256(concatBytes(K, H, k1));
    const expected = concatBytes(k1, k2).subarray(0, 48);
    expect(Array.from(deriveKey(K, H, 'C', sid, 48))).toEqual(Array.from(expected));
  });

  it('truncates to exactly the requested length', () => {
    expect(deriveKey(K, H, 'A', sid, 12).length).toBe(12);
  });
});
