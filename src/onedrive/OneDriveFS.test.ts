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
  getUploadSessionStatus: vi.fn(),
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

  it('abort leaves the session retained (no cancelUpload) so a later resume can pick it up', async () => {
    g.createUploadSession.mockResolvedValue('https://upload');
    g.putUploadChunk.mockResolvedValue(undefined);
    const big = 5 * 1024 * 1024; // > SIMPLE_LIMIT so a session is created
    const fs = new OneDriveFS(auth);
    const w = await fs.openWrite('/big-abort.bin', big);
    await w.write(new Uint8Array(10 * 320 * 1024));
    await w.abort();
    expect(g.cancelUpload).not.toHaveBeenCalled();
  });
});

describe('OneDriveFS openWrite resume (M3)', () => {
  const ALIGN = 320 * 1024;

  it('fresh large openWrite creates a session with startOffset 0', async () => {
    g.createUploadSession.mockResolvedValue('https://up1');
    const fs = new OneDriveFS(auth);
    const w = await fs.openWrite('/resume1.bin', 40 * ALIGN);
    // startOffset should be readable without any writes; createUploadSession is
    // created lazily on first flush, so trigger it with a write.
    await w.write(new Uint8Array(10 * ALIGN));
    expect(w.startOffset).toBe(0);
    expect(g.createUploadSession).toHaveBeenCalledTimes(1);
  });

  it('resume:true reuses the retained session and starts at nextExpectedRanges offset', async () => {
    g.createUploadSession.mockResolvedValue('https://retained');
    g.putUploadChunk.mockResolvedValue(undefined);
    const total = 40 * ALIGN;
    const fs = new OneDriveFS(auth);

    // First attempt: create a session, write a bit, then abort (session retained).
    const w1 = await fs.openWrite('/resume2.bin', total);
    await w1.write(new Uint8Array(10 * ALIGN));
    await w1.abort();
    expect(g.createUploadSession).toHaveBeenCalledTimes(1);
    g.putUploadChunk.mockClear();

    // Second attempt, resuming: status says resume from ALIGN.
    g.getUploadSessionStatus.mockResolvedValue({ nextOffset: ALIGN });
    const w2 = await fs.openWrite('/resume2.bin', total, { resume: true });
    expect(g.getUploadSessionStatus).toHaveBeenCalledWith('https://retained');
    expect(w2.startOffset).toBe(ALIGN);

    await w2.write(new Uint8Array(10 * ALIGN));
    await w2.close();

    // createUploadSession was NOT called again — the retained session was reused.
    expect(g.createUploadSession).toHaveBeenCalledTimes(1);
    const calls = g.putUploadChunk.mock.calls as [string, Uint8Array, number, number][];
    expect(calls[0][0]).toBe('https://retained');
    expect(calls[0][2]).toBe(ALIGN); // first chunk's start offset === resumed offset
  });

  it('resume:true with no retained/valid session falls back to a fresh session', async () => {
    g.createUploadSession.mockResolvedValue('https://fresh');
    g.getUploadSessionStatus.mockResolvedValue(null);
    const total = 40 * ALIGN;
    const fs = new OneDriveFS(auth);
    const w = await fs.openWrite('/never-started.bin', total, { resume: true });
    await w.write(new Uint8Array(10 * ALIGN));
    expect(w.startOffset).toBe(0);
    expect(g.createUploadSession).toHaveBeenCalledTimes(1);
  });

  it('resume:true when a retained session has since expired falls back to fresh', async () => {
    g.createUploadSession.mockResolvedValueOnce('https://expiring');
    g.putUploadChunk.mockResolvedValue(undefined);
    const total = 40 * ALIGN;
    const fs = new OneDriveFS(auth);
    const w1 = await fs.openWrite('/resume3.bin', total);
    await w1.write(new Uint8Array(10 * ALIGN));
    await w1.abort();

    g.getUploadSessionStatus.mockResolvedValue(null); // session expired server-side
    g.createUploadSession.mockResolvedValueOnce('https://fresh2');
    const w2 = await fs.openWrite('/resume3.bin', total, { resume: true });
    await w2.write(new Uint8Array(10 * ALIGN));
    expect(w2.startOffset).toBe(0);
    expect(g.createUploadSession).toHaveBeenCalledTimes(2);
  });

  it('on successful close the session is removed, so a later resume starts fresh', async () => {
    g.createUploadSession.mockResolvedValueOnce('https://session-a');
    g.putUploadChunk.mockResolvedValue(undefined);
    const total = 40 * ALIGN;
    const fs = new OneDriveFS(auth);
    const w1 = await fs.openWrite('/resume4.bin', total);
    for (let i = 0; i < 4; i++) await w1.write(new Uint8Array(10 * ALIGN));
    await w1.close();
    expect(g.createUploadSession).toHaveBeenCalledTimes(1);

    // Nothing retained now: even with resume:true, a fresh session is created.
    g.createUploadSession.mockResolvedValueOnce('https://session-b');
    const w2 = await fs.openWrite('/resume4.bin', total, { resume: true });
    await w2.write(new Uint8Array(10 * ALIGN));
    expect(g.getUploadSessionStatus).not.toHaveBeenCalled();
    expect(w2.startOffset).toBe(0);
    expect(g.createUploadSession).toHaveBeenCalledTimes(2);
  });

  it('small-file non-resume path is unaffected (uploadSmall, startOffset 0)', async () => {
    g.uploadSmall.mockResolvedValue(undefined);
    const fs = new OneDriveFS(auth);
    const w = await fs.openWrite('/small2.bin', 3);
    expect(w.startOffset).toBe(0);
    await w.write(new Uint8Array([1, 2, 3]));
    await w.close();
    expect(g.uploadSmall).toHaveBeenCalledTimes(1);
    expect(g.createUploadSession).not.toHaveBeenCalled();
    expect(g.getUploadSessionStatus).not.toHaveBeenCalled();
  });
});

describe('OneDriveFS openWrite streaming', () => {
  it('streams a large known-size upload as contiguous chunks summing to total', async () => {
    g.createUploadSession.mockResolvedValue('https://up');
    g.putUploadChunk.mockResolvedValue(undefined);
    const ALIGN = 320 * 1024;
    const total = 40 * ALIGN; // 12.8 MB, well over the 4 MB simple-PUT limit
    const fs = new OneDriveFS(auth);
    const w = await fs.openWrite('/big.bin', total);
    for (let i = 0; i < 4; i++) await w.write(new Uint8Array(10 * ALIGN));
    await w.close();
    const calls = g.putUploadChunk.mock.calls as [string, Uint8Array, number, number][];
    expect(calls.length).toBeGreaterThan(1); // actually streamed, not one giant PUT
    let expectedStart = 0;
    for (const [url, bytes, start, tot] of calls) {
      expect(url).toBe('https://up');
      expect(tot).toBe(total);
      expect(start).toBe(expectedStart); // contiguous, in order
      expectedStart += bytes.byteLength;
    }
    expect(expectedStart).toBe(total); // every byte sent exactly once
    expect(g.uploadSmall).not.toHaveBeenCalled();
  });
});

describe('OneDriveFS rename edges', () => {
  it('renames and moves at once', async () => {
    g.patchItem.mockResolvedValue(undefined);
    await new OneDriveFS(auth).rename('/a.txt', '/sub/b.txt');
    expect(g.patchItem).toHaveBeenCalledWith(auth, '/a.txt', { name: 'b.txt', newParentPath: '/sub' });
  });

  it('rename to the same path is a no-op', async () => {
    await new OneDriveFS(auth).rename('/a.txt', '/a.txt');
    expect(g.patchItem).not.toHaveBeenCalled();
  });
});
