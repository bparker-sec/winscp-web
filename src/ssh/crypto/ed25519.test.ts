import { describe, it, expect } from 'vitest';
import { ed25519Verify } from './ed25519';

function hex(h: string): Uint8Array {
  return Uint8Array.from(h.match(/.{2}/g)?.map((b) => parseInt(b, 16)) ?? []);
}

describe('ed25519 verify', () => {
  const pub = hex('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
  const msg = hex(''); // empty message (TEST 1)
  const sig = hex(
    'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
  );

  it('accepts a valid signature', () => {
    expect(ed25519Verify(sig, msg, pub)).toBe(true);
  });
  it('rejects a tampered signature', () => {
    const bad = sig.slice();
    bad[0] ^= 0xff;
    expect(ed25519Verify(bad, msg, pub)).toBe(false);
  });
  it('never throws on malformed input', () => {
    expect(ed25519Verify(new Uint8Array(3), msg, pub)).toBe(false);
  });
});
