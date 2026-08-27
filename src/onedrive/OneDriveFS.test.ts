import { describe, it, expect, vi, beforeEach } from 'vitest';

// `vi.hoisted` guarantees `g` exists before the hoisted `vi.mock` factory runs,
// so the factory can safely spread the spies over the real module.
const g = vi.hoisted(() => ({
  listChildren: vi.fn(),
  getItem: vi.fn(),
  createFolder: vi.fn(),
  deleteItem: vi.fn(),
  patchItem: vi.fn(),
  downloadRange: vi.fn(),
  uploadSmall: vi.fn(),
  createUploadSession: vi.fn(),
  putUploadChunk: vi.fn(),
  cancelUpload: vi.fn(),
}));

vi.mock('./graph', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./graph')>();
  return { ...actual, ...g };
});

import { OneDriveFS } from './OneDriveFS';
import { FsError } from '../fs/FileSystem';
import { GraphError } from './graph';

const auth = { getToken: async () => 'token' };

beforeEach(() => {
  Object.values(g).forEach((fn) => fn.mockReset());
});

describe('OneDriveFS listing', () => {
  it('maps and sorts children (folders first)', async () => {
    g.listChildren.mockResolvedValue([
      { id: '1', name: 'zeta.txt', size: 1, file: {} },
      { id: '2', name: 'Apps', folder: {} },
    ]);
    const fs = new OneDriveFS(auth);
    const entries = await fs.list('/');
    expect(entries.map((e) => e.name)).toEqual(['Apps', 'zeta.txt']);
    expect(entries[0].path).toBe('/Apps');
  });

  it('maps a 404 to FsError not-found', async () => {
    g.listChildren.mockRejectedValue(new GraphError(404, 'nope'));
    const fs = new OneDriveFS(auth);
    await expect(fs.list('/missing')).rejects.toMatchObject({ code: 'not-found' });
    await expect(fs.list('/missing')).rejects.toBeInstanceOf(FsError);
  });
});

describe('OneDriveFS remove', () => {
  it('refuses a non-empty folder without recursive', async () => {
    g.getItem.mockResolvedValue({ id: '1', name: 'D', folder: { childCount: 3 } });
    const fs = new OneDriveFS(auth);
    await expect(fs.remove('/D', false)).rejects.toMatchObject({ code: 'not-empty' });
    expect(g.deleteItem).not.toHaveBeenCalled();
  });

  it('deletes a file', async () => {
    g.getItem.mockResolvedValue({ id: '1', name: 'a.txt', file: {} });
    g.deleteItem.mockResolvedValue(undefined);
    const fs = new OneDriveFS(auth);
    await fs.remove('/a.txt', false);
    expect(g.deleteItem).toHaveBeenCalledWith(auth, '/a.txt');
  });
});

describe('OneDriveFS rename', () => {
  it('renames within the same folder (name only)', async () => {
    g.patchItem.mockResolvedValue(undefined);
    const fs = new OneDriveFS(auth);
    await fs.rename('/a.txt', '/b.txt');
    expect(g.patchItem).toHaveBeenCalledWith(auth, '/a.txt', { name: 'b.txt' });
  });

  it('moves to another folder (parent + maybe name)', async () => {
    g.patchItem.mockResolvedValue(undefined);
    const fs = new OneDriveFS(auth);
    await fs.rename('/a.txt', '/sub/a.txt');
    expect(g.patchItem).toHaveBeenCalledWith(auth, '/a.txt', { newParentPath: '/sub' });
  });
});

describe('OneDriveFS openRead', () => {
  it('streams ranged reads and signals EOF', async () => {
    g.getItem.mockResolvedValue({ id: '1', name: 'a', file: {}, size: 5 });
    g.downloadRange.mockImplementation(async (_a, _p, start: number, end: number) =>
      new Uint8Array([1, 2, 3, 4, 5].slice(start, end + 1)).buffer,
    );
    const fs = new OneDriveFS(auth);
    const r = await fs.openRead('/a');
    const b = new Uint8Array(3);
    expect(await r.read(b)).toBe(3);
    expect(Array.from(b)).toEqual([1, 2, 3]);
    const b2 = new Uint8Array(3);
    expect(await r.read(b2)).toBe(2);
    expect(await r.read(new Uint8Array(3))).toBe(0);
  });

  it('throws not-a-file on a folder', async () => {
    g.getItem.mockResolvedValue({ id: '1', name: 'D', folder: {} });
    const fs = new OneDriveFS(auth);
    await expect(fs.openRead('/D')).rejects.toMatchObject({ code: 'not-a-file' });
  });
});

describe('OneDriveFS openWrite', () => {
  it('uses a single PUT for a small known-size file', async () => {
    g.uploadSmall.mockResolvedValue(undefined);
    const fs = new OneDriveFS(auth);
    const w = await fs.openWrite('/small.bin', 3);
    await w.write(new Uint8Array([1, 2, 3]));
    await w.close();
    expect(g.uploadSmall).toHaveBeenCalledTimes(1);
    expect(g.createUploadSession).not.toHaveBeenCalled();
  });

  it('abort cancels an open upload session', async () => {
    g.createUploadSession.mockResolvedValue('https://upload');
    g.putUploadChunk.mockResolvedValue(undefined);
    g.cancelUpload.mockResolvedValue(undefined);
    const big = 5 * 1024 * 1024; // > SIMPLE_LIMIT so a session is created
    const fs = new OneDriveFS(auth);
    const w = await fs.openWrite('/big.bin', big);
    await w.write(new Uint8Array(10 * 320 * 1024));
    await w.abort();
    expect(g.cancelUpload).toHaveBeenCalledWith('https://upload');
  });
});
