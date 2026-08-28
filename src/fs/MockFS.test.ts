import { describe, it, expect } from 'vitest';
import { joinPath, parentPath, sortEntries, FsError, type FsEntry } from './FileSystem';
import { MockFS } from './MockFS';

describe('path helpers', () => {
  it('joins paths', () => {
    expect(joinPath('/', 'a')).toBe('/a');
    expect(joinPath('/a', 'b')).toBe('/a/b');
    expect(joinPath('/a/', 'b')).toBe('/a/b');
  });
  it('finds parents', () => {
    expect(parentPath('/a/b')).toBe('/a');
    expect(parentPath('/a')).toBe('/');
    expect(parentPath('/')).toBe('/');
  });
  it('sorts folders first then alpha', () => {
    const e: FsEntry[] = [
      { name: 'zeta.txt', path: '/zeta.txt', kind: 'file' },
      { name: 'Apps', path: '/Apps', kind: 'dir' },
      { name: 'alpha.txt', path: '/alpha.txt', kind: 'file' },
    ];
    expect(sortEntries(e).map((x) => x.name)).toEqual(['Apps', 'alpha.txt', 'zeta.txt']);
  });
});

describe('MockFS listing & navigation', () => {
  it('lists the seeded root and navigates into a folder', async () => {
    const fs = new MockFS();
    const root = await fs.list('/');
    expect(root.map((e) => e.name)).toContain('Documents');
    const docs = await fs.list('/Documents');
    expect(docs.length).toBeGreaterThan(0);
  });

  it('lists only direct children (not nested)', async () => {
    const fs = new MockFS();
    const root = await fs.list('/');
    expect(root.map((e) => e.name)).not.toContain('Projects');
  });
});

describe('MockFS mutations', () => {
  it('mkdir then list shows the new folder', async () => {
    const fs = new MockFS();
    await fs.mkdir('/NewFolder');
    const root = await fs.list('/');
    expect(root.find((e) => e.name === 'NewFolder')?.kind).toBe('dir');
  });

  it('mkdir throws FsError("exists") on an existing path', async () => {
    const fs = new MockFS();
    await expect(fs.mkdir('/Documents')).rejects.toMatchObject({ code: 'exists' });
  });

  it('stat throws FsError("not-found") on a missing path', async () => {
    const fs = new MockFS();
    await expect(fs.stat('/nope')).rejects.toBeInstanceOf(FsError);
    await expect(fs.stat('/nope')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('remove refuses a non-empty directory without recursive', async () => {
    const fs = new MockFS();
    await expect(fs.remove('/Documents', false)).rejects.toMatchObject({ code: 'not-empty' });
  });

  it('remove deletes a directory recursively', async () => {
    const fs = new MockFS();
    await fs.remove('/Documents', true);
    const root = await fs.list('/');
    expect(root.map((e) => e.name)).not.toContain('Documents');
    await expect(fs.stat('/Documents/notes.txt')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('refuses to remove the root', async () => {
    const fs = new MockFS();
    await expect(fs.remove('/', true)).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('rename moves a file to a new name', async () => {
    const fs = new MockFS();
    await fs.rename('/readme.md', '/README.md');
    const names = (await fs.list('/')).map((e) => e.name);
    expect(names).toContain('README.md');
    expect(names).not.toContain('readme.md');
  });

  it('move delegates to rename', async () => {
    const fs = new MockFS();
    await fs.move('/readme.md', '/Documents/readme.md');
    const docs = await fs.list('/Documents');
    expect(docs.map((e) => e.name)).toContain('readme.md');
  });
});

describe('MockFS streaming', () => {
  it('round-trips bytes through openWrite/openRead', async () => {
    const fs = new MockFS();
    const w = await fs.openWrite('/hello.bin');
    await w.write(new Uint8Array([1, 2, 3]));
    await w.write(new Uint8Array([4, 5]));
    await w.close();
    const r = await fs.openRead('/hello.bin');
    const buf = new Uint8Array(5);
    const n = await r.read(buf);
    await r.close();
    expect(n).toBe(5);
    expect(Array.from(buf)).toEqual([1, 2, 3, 4, 5]);
  });

  it('reads across multiple calls and returns 0 at EOF', async () => {
    const fs = new MockFS();
    const w = await fs.openWrite('/multi.bin');
    await w.write(new Uint8Array([10, 20, 30, 40]));
    await w.close();
    const r = await fs.openRead('/multi.bin');
    const b1 = new Uint8Array(3);
    expect(await r.read(b1)).toBe(3);
    expect(Array.from(b1)).toEqual([10, 20, 30]);
    const b2 = new Uint8Array(3);
    expect(await r.read(b2)).toBe(1);
    expect(b2[0]).toBe(40);
    expect(await r.read(new Uint8Array(3))).toBe(0); // EOF
    await r.close();
  });

  it('abort discards an in-progress write', async () => {
    const fs = new MockFS();
    const w = await fs.openWrite('/ghost.bin');
    await w.write(new Uint8Array([9, 9, 9]));
    await w.abort();
    await expect(fs.stat('/ghost.bin')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('openRead throws FsError("not-a-file") on a directory', async () => {
    const fs = new MockFS();
    await expect(fs.openRead('/Documents')).rejects.toMatchObject({ code: 'not-a-file' });
  });
});

describe('MockFS resume support', () => {
  it('openRead with an offset serves bytes from that offset to EOF', async () => {
    const fs = new MockFS();
    const w = await fs.openWrite('/off.bin');
    await w.write(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    await w.close();

    const r = await fs.openRead('/off.bin', 3);
    const buf = new Uint8Array(10);
    const n = await r.read(buf);
    await r.close();
    expect(n).toBe(5);
    expect(Array.from(buf.subarray(0, n))).toEqual([4, 5, 6, 7, 8]);
  });

  it('openRead with offset at EOF returns 0 immediately', async () => {
    const fs = new MockFS();
    const w = await fs.openWrite('/eof.bin');
    await w.write(new Uint8Array([1, 2, 3]));
    await w.close();

    const r = await fs.openRead('/eof.bin', 3);
    expect(await r.read(new Uint8Array(10))).toBe(0);
    await r.close();
  });

  it('openWrite without resume truncates: startOffset is 0 and old bytes are gone', async () => {
    const fs = new MockFS();
    const w1 = await fs.openWrite('/trunc.bin');
    expect(w1.startOffset).toBe(0);
    await w1.write(new Uint8Array([9, 9, 9, 9, 9]));
    await w1.close();

    const w2 = await fs.openWrite('/trunc.bin');
    expect(w2.startOffset).toBe(0);
    await w2.write(new Uint8Array([1, 2]));
    await w2.close();

    const r = await fs.openRead('/trunc.bin');
    const buf = new Uint8Array(10);
    const n = await r.read(buf);
    await r.close();
    expect(Array.from(buf.subarray(0, n))).toEqual([1, 2]);
  });

  it('openWrite({resume: true}) on an existing file reports startOffset = existing length and appends', async () => {
    const fs = new MockFS();
    const w1 = await fs.openWrite('/resume.bin');
    await w1.write(new Uint8Array([1, 2, 3, 4]));
    await w1.close();

    const w2 = await fs.openWrite('/resume.bin', undefined, { resume: true });
    expect(w2.startOffset).toBe(4);
    await w2.write(new Uint8Array([5, 6]));
    await w2.close();

    const r = await fs.openRead('/resume.bin');
    const buf = new Uint8Array(10);
    const n = await r.read(buf);
    await r.close();
    expect(Array.from(buf.subarray(0, n))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('openWrite({resume: true}) on a non-existent file behaves like a fresh write (startOffset 0)', async () => {
    const fs = new MockFS();
    const w = await fs.openWrite('/new-resume.bin', undefined, { resume: true });
    expect(w.startOffset).toBe(0);
    await w.write(new Uint8Array([7, 8]));
    await w.close();

    const r = await fs.openRead('/new-resume.bin');
    const buf = new Uint8Array(10);
    const n = await r.read(buf);
    await r.close();
    expect(Array.from(buf.subarray(0, n))).toEqual([7, 8]);
  });
});
