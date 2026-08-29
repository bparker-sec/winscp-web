import { describe, it, expect } from 'vitest';
import { MockFS } from '../fs/MockFS';
import type { FileSystem, FsEntry } from '../fs/FileSystem';
import { fileNeedsCopy, computeSyncPlan, planTotalBytes, synchronize } from './sync';
import { TransferCancelled } from './engine';

async function writeFile(fs: FileSystem, path: string, text: string): Promise<void> {
  const data = new TextEncoder().encode(text);
  const w = await fs.openWrite(path, data.byteLength);
  await w.write(data);
  await w.close();
}

async function readText(fs: FileSystem, path: string): Promise<string> {
  const r = await fs.openRead(path);
  const buf = new Uint8Array(4096);
  const chunks: Uint8Array[] = [];
  for (;;) {
    const n = await r.read(buf);
    if (n === 0) break;
    chunks.push(buf.slice(0, n));
  }
  await r.close();
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return new TextDecoder().decode(out);
}

function fileEntry(over: Partial<FsEntry>): FsEntry {
  return { name: 'f', path: '/f', kind: 'file', size: 10, mtime: 1000, ...over };
}

describe('fileNeedsCopy', () => {
  it("returns 'new' when the destination is missing", () => {
    expect(fileNeedsCopy(fileEntry({}), undefined, 'size-mtime', 2000)).toBe('new');
  });

  it("returns 'changed' when sizes differ", () => {
    expect(fileNeedsCopy(fileEntry({ size: 20 }), fileEntry({ size: 10 }), 'size', 2000)).toBe('changed');
  });

  it("returns 'changed' when the source mtime is newer beyond tolerance (size-mtime)", () => {
    const src = fileEntry({ size: 10, mtime: 10_000 });
    const dst = fileEntry({ size: 10, mtime: 5_000 });
    expect(fileNeedsCopy(src, dst, 'size-mtime', 2000)).toBe('changed');
  });

  it('ignores mtime within tolerance', () => {
    const src = fileEntry({ size: 10, mtime: 6_500 });
    const dst = fileEntry({ size: 10, mtime: 5_000 });
    expect(fileNeedsCopy(src, dst, 'size-mtime', 2000)).toBeNull();
  });

  it("ignores mtime entirely in 'size' mode", () => {
    const src = fileEntry({ size: 10, mtime: 999_999 });
    const dst = fileEntry({ size: 10, mtime: 0 });
    expect(fileNeedsCopy(src, dst, 'size', 2000)).toBeNull();
  });

  it("returns 'changed' when a directory sits where the source file should go", () => {
    expect(fileNeedsCopy(fileEntry({}), fileEntry({ kind: 'dir', size: undefined }), 'size', 2000)).toBe('changed');
  });
});

describe('computeSyncPlan', () => {
  it('plans copies for new + changed files and mkdir for missing dirs, top-down', async () => {
    const src = new MockFS('src');
    const dst = new MockFS('dst');
    await src.mkdir('/s');
    await dst.mkdir('/d');
    await src.mkdir('/s/sub');
    await writeFile(src, '/s/a.txt', 'aaaa'); // new
    await writeFile(src, '/s/sub/b.txt', 'bb'); // new (in new dir)
    await writeFile(src, '/s/c.txt', 'cccccc'); // changed (size differs from dst)
    await writeFile(dst, '/d/c.txt', 'xx'); // smaller → changed

    const plan = await computeSyncPlan(src, '/s', dst, '/d');
    const kinds = plan.map((a) => `${a.kind}:${a.kind === 'copy' ? a.name : (a as any).dstPath}`);

    // mkdir /d/sub must precede the copy of b.txt into it.
    const mkdirIdx = plan.findIndex((a) => a.kind === 'mkdir' && a.dstPath === '/d/sub');
    const bIdx = plan.findIndex((a) => a.kind === 'copy' && a.name === 'b.txt');
    expect(mkdirIdx).toBeGreaterThanOrEqual(0);
    expect(mkdirIdx).toBeLessThan(bIdx);

    const copies = plan.filter((a) => a.kind === 'copy').map((a) => (a as any).name).sort();
    expect(copies).toEqual(['a.txt', 'b.txt', 'c.txt']);
    // Unchanged files produce no action; nothing else here besides the above.
    expect(kinds.length).toBe(4); // mkdir sub + 3 copies
  });

  it("update mode does NOT delete extraneous destination entries; mirror does", async () => {
    const src = new MockFS('src');
    const dst = new MockFS('dst');
    await src.mkdir('/s');
    await dst.mkdir('/d');
    await writeFile(dst, '/d/stale.txt', 'old');
    await dst.mkdir('/d/staledir');

    const update = await computeSyncPlan(src, '/s', dst, '/d', { mode: 'update' });
    expect(update.some((a) => a.kind === 'delete')).toBe(false);

    const mirror = await computeSyncPlan(src, '/s', dst, '/d', { mode: 'mirror' });
    const deletes = new Set(mirror.filter((a) => a.kind === 'delete').map((a) => (a as any).name));
    expect(deletes).toEqual(new Set(['staledir', 'stale.txt']));
  });

  it('plans nothing when the trees already match', async () => {
    const src = new MockFS('src');
    const dst = new MockFS('dst');
    await src.mkdir('/s');
    await dst.mkdir('/d');
    await writeFile(src, '/s/same.txt', 'identical');
    await writeFile(dst, '/d/same.txt', 'identical'); // same size, size mode
    const plan = await computeSyncPlan(src, '/s', dst, '/d', { compareBy: 'size' });
    expect(plan).toEqual([]);
  });
});

describe('synchronize', () => {
  it('mirrors a source tree into a fresh destination, byte-exact, and reports counts', async () => {
    const src = new MockFS('src');
    const dst = new MockFS('dst');
    await src.mkdir('/s');
    await src.mkdir('/s/nested');
    await writeFile(src, '/s/one.txt', 'first file');
    await writeFile(src, '/s/nested/two.txt', 'second file contents');

    const result = await synchronize(src, '/s', dst, '/d', { compareBy: 'size' });

    expect(result.copied).toBe(2);
    expect(result.created).toBeGreaterThanOrEqual(1); // /d/nested (and /d root ensured)
    expect(result.deleted).toBe(0);
    await expect(readText(dst, '/d/one.txt')).resolves.toBe('first file');
    await expect(readText(dst, '/d/nested/two.txt')).resolves.toBe('second file contents');
  });

  it('mirror mode deletes destination files not present in the source', async () => {
    const src = new MockFS('src');
    const dst = new MockFS('dst');
    await src.mkdir('/s');
    await dst.mkdir('/d');
    await writeFile(src, '/s/keep.txt', 'keep me');
    await writeFile(dst, '/d/keep.txt', 'keep me');
    await writeFile(dst, '/d/remove.txt', 'delete me');

    const result = await synchronize(src, '/s', dst, '/d', { mode: 'mirror', compareBy: 'size' });

    expect(result.deleted).toBe(1);
    await expect(dst.stat('/d/remove.txt')).rejects.toMatchObject({ code: 'not-found' });
    await expect(dst.stat('/d/keep.txt')).resolves.toMatchObject({ name: 'keep.txt' });
  });

  it('reports cumulative byte progress across files', async () => {
    const src = new MockFS('src');
    const dst = new MockFS('dst');
    await src.mkdir('/s');
    await writeFile(src, '/s/a', 'aaaaa'); // 5
    await writeFile(src, '/s/b', 'bbbbbbbbbb'); // 10

    const seen: number[] = [];
    const result = await synchronize(src, '/s', dst, '/d', {
      compareBy: 'size',
      onProgress: (p) => seen.push(p.bytes),
    });
    expect(result.bytes).toBe(15);
    expect(Math.max(...seen)).toBe(15);
  });

  it('aborts cooperatively when the signal is already aborted', async () => {
    const src = new MockFS('src');
    const dst = new MockFS('dst');
    await src.mkdir('/s');
    await writeFile(src, '/s/a', 'data');
    const ac = new AbortController();
    ac.abort();
    await expect(synchronize(src, '/s', dst, '/d', { signal: ac.signal })).rejects.toBeInstanceOf(
      TransferCancelled,
    );
  });

  it('planTotalBytes sums only copy sizes', () => {
    expect(
      planTotalBytes([
        { kind: 'copy', srcPath: '/a', dstPath: '/a', name: 'a', size: 5, reason: 'new' },
        { kind: 'mkdir', dstPath: '/d', name: 'd' },
        { kind: 'copy', srcPath: '/b', dstPath: '/b', name: 'b', size: 7, reason: 'changed' },
        { kind: 'delete', dstPath: '/x', name: 'x', isDir: false },
      ]),
    ).toBe(12);
  });
});
