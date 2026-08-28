import { describe, expect, it } from 'vitest';
import { SshReader, SshWriter } from '../ssh/wire';
import { decodeAttrs, encodeAttrs, type FileAttrs } from './attrs';
import { SSH_FX_NO_SUCH_FILE, SSH_FX_OK } from './constants';
import {
  buildOpen,
  buildRead,
  buildRename,
  parseAttrs,
  parseData,
  parseHandle,
  parseName,
  parseStatus,
  parseVersion,
} from './protocol';

const SSH_FXF_READ = 0x1;
const SSH_FXF_WRITE = 0x2;

describe('protocol builders — exact bytes', () => {
  it('buildOpen encodes id, path, pflags, and attrs; length counts type+body', () => {
    const attrs: FileAttrs = { permissions: 0o100644 };
    const pkt = buildOpen(7, '/tmp/foo', SSH_FXF_READ | SSH_FXF_WRITE, attrs);

    const r = new SshReader(pkt);
    const length = r.uint32();
    expect(length).toBe(pkt.length - 4);

    const type = r.byte();
    expect(type).toBe(3); // SSH_FXP_OPEN

    const id = r.uint32();
    expect(id).toBe(7);

    const path = new TextDecoder().decode(r.string());
    expect(path).toBe('/tmp/foo');

    const pflags = r.uint32();
    expect(pflags).toBe(SSH_FXF_READ | SSH_FXF_WRITE);

    const decodedAttrs = decodeAttrs(r);
    expect(decodedAttrs).toEqual(attrs);

    // Body fully consumed.
    expect(r.remaining().length).toBe(0);
  });

  it('buildRead encodes offset as uint64 and length as uint32', () => {
    const handle = new TextEncoder().encode('h1');
    const pkt = buildRead(3, handle, 1099511627776, 65536); // offset > 32 bits to prove uint64

    const r = new SshReader(pkt);
    const length = r.uint32();
    expect(length).toBe(pkt.length - 4);
    expect(r.byte()).toBe(5); // SSH_FXP_READ
    expect(r.uint32()).toBe(3);
    expect(Array.from(r.string())).toEqual(Array.from(handle));
    expect(r.uint64()).toBe(1099511627776n);
    expect(r.uint32()).toBe(65536);
    expect(r.remaining().length).toBe(0);
  });

  it('buildRename encodes both paths', () => {
    const pkt = buildRename(42, '/a/old.txt', '/a/new.txt');

    const r = new SshReader(pkt);
    const length = r.uint32();
    expect(length).toBe(pkt.length - 4);
    expect(r.byte()).toBe(18); // SSH_FXP_RENAME
    expect(r.uint32()).toBe(42);
    expect(new TextDecoder().decode(r.string())).toBe('/a/old.txt');
    expect(new TextDecoder().decode(r.string())).toBe('/a/new.txt');
    expect(r.remaining().length).toBe(0);
  });
});

describe('protocol parsers — round-trip via hand-built bodies', () => {
  it('parseVersion reads uint32 version and ignores trailing extension pair bytes', () => {
    const w = new SshWriter().uint32(3).string('ext-name').string('ext-data');
    const body = w.finish();
    expect(parseVersion(body)).toEqual({ version: 3 });
  });

  it('parseStatus reads id, code, and message', () => {
    const w = new SshWriter()
      .uint32(9)
      .uint32(SSH_FX_NO_SUCH_FILE)
      .string('No such file')
      .string('en');
    const body = w.finish();
    const result = parseStatus(body);
    expect(result).toEqual({ id: 9, code: SSH_FX_NO_SUCH_FILE, message: 'No such file' });
  });

  it('parseStatus defensively parses a truncated STATUS (id+code only) as message ""', () => {
    const w = new SshWriter().uint32(9).uint32(SSH_FX_OK);
    const body = w.finish();
    const result = parseStatus(body);
    expect(result).toEqual({ id: 9, code: SSH_FX_OK, message: '' });
  });

  it('parseHandle reads id and handle bytes', () => {
    const handle = new TextEncoder().encode('handle-123');
    const w = new SshWriter().uint32(5).string(handle);
    const body = w.finish();
    const result = parseHandle(body);
    expect(result.id).toBe(5);
    expect(Array.from(result.handle)).toEqual(Array.from(handle));
  });

  it('parseData reads id and data bytes', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const w = new SshWriter().uint32(11).string(data);
    const body = w.finish();
    const result = parseData(body);
    expect(result.id).toBe(11);
    expect(Array.from(result.data)).toEqual(Array.from(data));
  });

  it('parseName reads id, count, and each (filename, longname, attrs) entry', () => {
    const attrsA: FileAttrs = { permissions: 0o40755, size: 4096 };
    const attrsB: FileAttrs = { permissions: 0o100644, size: 128 };
    const w = new SshWriter()
      .uint32(21)
      .uint32(2)
      .string('dir1')
      .string('drwxr-xr-x 1 owner group 4096 Jan 1 00:00 dir1')
      .raw(encodeAttrs(attrsA))
      .string('file1.txt')
      .string('-rw-r--r-- 1 owner group 128 Jan 1 00:00 file1.txt')
      .raw(encodeAttrs(attrsB));
    const body = w.finish();

    const result = parseName(body);
    expect(result.id).toBe(21);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].filename).toBe('dir1');
    expect(result.entries[0].attrs).toEqual(attrsA);
    expect(result.entries[1].filename).toBe('file1.txt');
    expect(result.entries[1].attrs).toEqual(attrsB);
  });

  it('parseAttrs reads id and an ATTRS blob', () => {
    const attrs: FileAttrs = { size: 999, mtime: 2000, atime: 1000 };
    const w = new SshWriter().uint32(31).raw(encodeAttrs(attrs));
    const body = w.finish();
    expect(parseAttrs(body)).toEqual({ id: 31, attrs });
  });
});
