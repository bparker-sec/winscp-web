import { describe, it, expect } from 'vitest';
import { gcmSeal, gcmOpen, incrementGcmIv } from './aesgcm';

function hex(h: string): Uint8Array {
  return Uint8Array.from(h.match(/.{2}/g)?.map((b) => parseInt(b, 16)) ?? []);
}
function toHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

describe('aes-256-gcm (NIST-style known answer)', () => {
  // NIST GCM: 256-bit key, 96-bit IV, empty AAD, 16-byte plaintext.
  const key = hex('feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308');
  const iv = hex('cafebabefacedbaddecaf888');
  const pt = hex('d9313225f88406e5a55909c5aff5269a');
  const expectedCt = '522dc1f099567d07f47f37a32a84427d';
  // Pinned once against noble's real GCM output (see task report for provenance).
  const expectedTag = '7ea353da7e9241a1d90d693a4954186b';

  it('seal produces ciphertext||tag and open recovers plaintext', () => {
    const sealed = gcmSeal(key, iv, new Uint8Array(0), pt);
    // ciphertext is the first pt.length bytes; tag is the last 16.
    expect(toHex(sealed.subarray(0, pt.length))).toBe(expectedCt);
    expect(toHex(sealed.subarray(pt.length))).toBe(expectedTag);
    expect(sealed.length).toBe(pt.length + 16);
    const opened = gcmOpen(key, iv, new Uint8Array(0), sealed);
    expect(toHex(opened)).toBe(toHex(pt));
  });

  it('open throws on a tampered tag', () => {
    const sealed = gcmSeal(key, iv, new Uint8Array(0), pt);
    sealed[sealed.length - 1] ^= 0xff;
    expect(() => gcmOpen(key, iv, new Uint8Array(0), sealed)).toThrow();
  });

  it('AAD is authenticated (wrong AAD fails to open)', () => {
    const sealed = gcmSeal(key, iv, Uint8Array.of(0, 0, 0, 5), pt);
    expect(() => gcmOpen(key, iv, Uint8Array.of(0, 0, 0, 6), sealed)).toThrow();
  });

  it('incrementGcmIv bumps only the 8-byte counter, big-endian', () => {
    const iv2 = hex('00000000ffffffffffffffff');
    incrementGcmIv(iv2);
    expect(toHex(iv2)).toBe('000000000000000000000000');
    const iv3 = hex('11111111000000000000000f');
    incrementGcmIv(iv3);
    expect(toHex(iv3)).toBe('111111110000000000000010');
  });
});
