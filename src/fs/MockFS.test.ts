import { describe, it, expect } from 'vitest';
import { joinPath, parentPath, sortEntries, type FsEntry } from './FileSystem';
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

describe('MockFS', () => {
  it('lists the seeded root and navigates into a folder', async () => {
    const fs = new MockFS();
    const root = await fs.list('/');
    expect(root.map((e) => e.name)).toContain('Documents');
    const docs = await fs.list('/Documents');
    expect(docs.length).toBeGreaterThan(0);
  });

  it('mkdir then list shows the new folder', async () => {
    const fs = new MockFS();
    await fs.mkdir('/NewFolder');
    const root = await fs.list('/');
    expect(root.find((e) => e.name === 'NewFolder')?.kind).toBe('dir');
  });

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
});
