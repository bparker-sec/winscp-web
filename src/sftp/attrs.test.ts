import { describe, expect, it } from 'vitest';
import { SshReader, SshWriter } from '../ssh/wire';
import { decodeAttrs, encodeAttrs, type FileAttrs } from './attrs';
import { SSH_FILEXFER_ATTR_EXTENDED } from './constants';

describe('attrs codec', () => {
  it('round-trips permissions-only', () => {
    const a: FileAttrs = { permissions: 0o100644 };
    const encoded = encodeAttrs(a);
    const decoded = decodeAttrs(new SshReader(encoded));
    expect(decoded).toEqual(a);
  });

  it('round-trips size + permissions + mtime (with atime, since ACMODTIME needs both)', () => {
    const a: FileAttrs = { size: 12345, permissions: 0o40755, atime: 1000, mtime: 2000 };
    const encoded = encodeAttrs(a);
    const decoded = decodeAttrs(new SshReader(encoded));
    expect(decoded).toEqual(a);
  });

  it('omits ACMODTIME entirely when only mtime is present', () => {
    const a: FileAttrs = { size: 42, mtime: 2000 };
    const encoded = encodeAttrs(a);
    const decoded = decodeAttrs(new SshReader(encoded));
    expect(decoded).toEqual({ size: 42 });
  });

  it('omits ACMODTIME entirely when only atime is present', () => {
    const a: FileAttrs = { atime: 1000 };
    const encoded = encodeAttrs(a);
    const decoded = decodeAttrs(new SshReader(encoded));
    expect(decoded).toEqual({});
  });

  it('empty attrs encodes to uint32 0 (4 zero bytes)', () => {
    const encoded = encodeAttrs({});
    expect(Array.from(encoded)).toEqual([0, 0, 0, 0]);
    const decoded = decodeAttrs(new SshReader(encoded));
    expect(decoded).toEqual({});
  });

  it('skips an EXTENDED block on decode and leaves the reader positioned correctly', () => {
    const w = new SshWriter();
    w.uint32(SSH_FILEXFER_ATTR_EXTENDED); // flags: only EXTENDED
    w.uint32(1); // one extension pair
    w.string('ext-type');
    w.string('ext-data');
    w.uint32(0xdeadbeef); // sentinel following the attrs blob
    const buf = w.finish();

    const r = new SshReader(buf);
    const decoded = decodeAttrs(r);
    expect(decoded).toEqual({});
    expect(r.uint32()).toBe(0xdeadbeef);
  });
});
