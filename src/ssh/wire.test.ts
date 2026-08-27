import { describe, it, expect } from 'vitest';
import { SshWriter, SshReader, normalizeMpint } from './wire';

describe('normalizeMpint', () => {
  it('strips leading zeros', () => {
    expect(Array.from(normalizeMpint(Uint8Array.of(0, 0, 1, 2)))).toEqual([1, 2]);
  });
  it('prepends 0x00 when the high bit is set (positive sign)', () => {
    expect(Array.from(normalizeMpint(Uint8Array.of(0x80, 0x01)))).toEqual([0x00, 0x80, 0x01]);
  });
  it('encodes zero as empty', () => {
    expect(Array.from(normalizeMpint(Uint8Array.of(0, 0)))).toEqual([]);
  });
});

describe('SshWriter/SshReader round-trip', () => {
  it('round-trips primitive types', () => {
    const w = new SshWriter()
      .byte(0x14)
      .bool(true)
      .uint32(0xdeadbeef)
      .string(new TextEncoder().encode('hello'))
      .nameList(['aes256-gcm@openssh.com', 'aes128-gcm@openssh.com'])
      .mpint(Uint8Array.of(0x80, 0x00));
    const r = new SshReader(w.finish());
    expect(r.byte()).toBe(0x14);
    expect(r.bool()).toBe(true);
    expect(r.uint32()).toBe(0xdeadbeef);
    expect(new TextDecoder().decode(r.string())).toBe('hello');
    expect(r.nameList()).toEqual(['aes256-gcm@openssh.com', 'aes128-gcm@openssh.com']);
    expect(Array.from(r.string())).toEqual([0x00, 0x80, 0x00]); // mpint written as a string
  });

  it('string() length-prefixes correctly', () => {
    const bytes = new TextEncoder().encode('abc');
    const buf = new SshWriter().string(bytes).finish();
    expect(Array.from(buf.subarray(0, 4))).toEqual([0, 0, 0, 3]);
  });

  it('reads an empty name-list as an empty array', () => {
    const buf = new SshWriter().nameList([]).finish();
    expect(new SshReader(buf).nameList()).toEqual([]);
  });
});
