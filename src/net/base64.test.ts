import { describe, it, expect } from 'vitest';
import { base64Encode, base64Decode } from './base64';

describe('base64', () => {
  it('encodes known vectors (RFC 4648)', () => {
    const enc = (s: string) => base64Encode(new TextEncoder().encode(s));
    expect(enc('')).toBe('');
    expect(enc('f')).toBe('Zg==');
    expect(enc('fo')).toBe('Zm8=');
    expect(enc('foo')).toBe('Zm9v');
    expect(enc('foob')).toBe('Zm9vYg==');
    expect(enc('fooba')).toBe('Zm9vYmE=');
    expect(enc('foobar')).toBe('Zm9vYmFy');
  });
  it('decodes back to the same bytes', () => {
    const dec = (s: string) => new TextDecoder().decode(base64Decode(s));
    expect(dec('Zm9vYmFy')).toBe('foobar');
    expect(dec('Zg==')).toBe('f');
    expect(dec('')).toBe('');
  });
  it('round-trips arbitrary binary', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    expect(Array.from(base64Decode(base64Encode(bytes)))).toEqual(Array.from(bytes));
  });
});
