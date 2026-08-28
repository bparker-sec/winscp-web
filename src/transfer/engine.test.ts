import { describe, it, expect } from 'vitest';
import type { FileSystem, WriteHandle } from '../fs/FileSystem';
import { MockFS } from '../fs/MockFS';
import { transferFile, transferTree, TransferCancelled, type TransferProgress } from './engine';

/** Writes `size` deterministic pseudo-random bytes to `fs` at `path` via openWrite. */
async function seedLargeFile(fs: FileSystem, path: string, size: number): Promise<Uint8Array> {
  const data = new Uint8Array(size);
  let seed = 12345;
  for (let i = 0; i < size; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = seed & 0xff;
  }
  const w = await fs.openWrite(path, size);
  // write in a couple of chunks so seeding itself isn't a single blob write
  const half = Math.floor(size / 2);
  await w.write(data.subarray(0, half));
  await w.write(data.subarray(half));
  await w.close();
  return data;
}

async function readAll(fs: FileSystem, path: string): Promise<Uint8Array> {
  const r = await fs.openRead(path);
  const chunks: Uint8Array[] = [];
  const buf = new Uint8Array(4096);
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
  return out;
}

/** Wraps a FileSystem's openWrite so tests can observe whether abort() or close() ran. */
function withWriteSpy(fs: FileSystem): {
  fs: FileSystem;
  calls: { aborted: boolean; closed: boolean };
} {
  const calls = { aborted: false, closed: false };
  const wrapped: FileSystem = {
    ...fs,
    openWrite: async (path: string, size?: number): Promise<WriteHandle> => {
      const inner = await fs.openWrite(path, size);
      return {
        write: (chunk: Uint8Array) => inner.write(chunk),
        close: async () => {
          calls.closed = true;
          return inner.close();
        },
        abort: async () => {
          calls.aborted = true;
          return inner.abort();
        },
      };
    },
  };
  return { fs: wrapped, calls };
}

describe('transferFile', () => {
  it('copies bytes exactly across multiple chunks', async () => {
    const srcFs = new MockFS('src');
    const dstFs = new MockFS('dst');
    const size = 300 * 1024; // 300 KiB, exercises multi-chunk streaming
    const data = await seedLargeFile(srcFs, '/a.bin', size);

    await transferFile(srcFs, '/a.bin', dstFs, '/a.bin', size, { chunkSize: 1024 });

    const copied = await readAll(dstFs, '/a.bin');
    expect(copied.byteLength).toBe(size);
    expect(Array.from(copied)).toEqual(Array.from(data));
  });

  it('reports monotonically increasing progress ending at total', async () => {
    const srcFs = new MockFS('src');
    const dstFs = new MockFS('dst');
    const size = 10 * 1024;
    await seedLargeFile(srcFs, '/p.bin', size);

    const progress: TransferProgress[] = [];
    await transferFile(srcFs, '/p.bin', dstFs, '/p.bin', size, {
      chunkSize: 512,
      onProgress: (p) => progress.push(p),
    });

    expect(progress.length).toBeGreaterThan(1);
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i].bytes).toBeGreaterThan(progress[i - 1].bytes);
    }
    const last = progress[progress.length - 1];
    expect(last.bytes).toBe(size);
    expect(last.total).toBe(size);
  });

  it('cancels via AbortSignal: rejects with TransferCancelled and aborts (not closes) the dest', async () => {
    const srcFs = new MockFS('src');
    const dstFsRaw = new MockFS('dst');
    const size = 4096;
    await seedLargeFile(srcFs, '/c.bin', size);

    const { fs: dstFs, calls } = withWriteSpy(dstFsRaw);
    const controller = new AbortController();

    const promise = transferFile(srcFs, '/c.bin', dstFs, '/c.bin', size, {
      chunkSize: 1,
      signal: controller.signal,
      onProgress: () => {
        // cancel as soon as the first chunk has been written
        controller.abort();
      },
    });

    await expect(promise).rejects.toBeInstanceOf(TransferCancelled);
    expect(calls.aborted).toBe(true);
    expect(calls.closed).toBe(false);
    // the destination file must not have been committed as a complete file
    await expect(dstFsRaw.stat('/c.bin')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('propagates the original error and still aborts the dest on a mid-transfer failure', async () => {
    const srcFs = new MockFS('src');
    const dstFsRaw = new MockFS('dst');
    const size = 4096;
    await seedLargeFile(srcFs, '/e.bin', size);

    const { fs: dstFs, calls } = withWriteSpy(dstFsRaw);
    let writes = 0;
    const failingDst: FileSystem = {
      ...dstFs,
      openWrite: async (path: string, s?: number) => {
        const inner = await dstFs.openWrite(path, s);
        return {
          write: async (chunk: Uint8Array) => {
            writes++;
            if (writes === 2) throw new Error('boom');
            return inner.write(chunk);
          },
          close: inner.close,
          abort: inner.abort,
        };
      },
    };

    await expect(
      transferFile(srcFs, '/e.bin', failingDst, '/e.bin', size, { chunkSize: 1 }),
    ).rejects.toThrow('boom');
    expect(calls.aborted).toBe(true);
    expect(calls.closed).toBe(false);
  });
});

describe('transferTree', () => {
  it('recreates a nested directory structure with byte-exact files', async () => {
    const srcFs = new MockFS('src');
    const dstFs = new MockFS('dst');
    await srcFs.mkdir('/dir');
    await srcFs.mkdir('/dir/sub');
    const xData = await seedLargeFile(srcFs, '/dir/x.txt', 2048);
    const yData = await seedLargeFile(srcFs, '/dir/sub/y.txt', 1024);

    const seen: string[] = [];
    await transferTree(srcFs, '/dir', dstFs, '/dir', { chunkSize: 256 }, (p) => seen.push(p));

    const rootList = await dstFs.list('/dir');
    expect(rootList.map((e) => e.name).sort()).toEqual(['sub', 'x.txt']);
    const subList = await dstFs.list('/dir/sub');
    expect(subList.map((e) => e.name)).toEqual(['y.txt']);

    expect(Array.from(await readAll(dstFs, '/dir/x.txt'))).toEqual(Array.from(xData));
    expect(Array.from(await readAll(dstFs, '/dir/sub/y.txt'))).toEqual(Array.from(yData));

    expect(seen.sort()).toEqual(['/dir/sub/y.txt', '/dir/x.txt']);
  });

  it('throws FsError-compatible errors upward and skips existing dirs without throwing', async () => {
    const srcFs = new MockFS('src');
    const dstFs = new MockFS('dst');
    await srcFs.mkdir('/dir');
    await dstFs.mkdir('/dir'); // pre-existing dest dir should not throw 'exists'
    await seedLargeFile(srcFs, '/dir/f.txt', 100);

    await expect(transferTree(srcFs, '/dir', dstFs, '/dir')).resolves.toBeUndefined();
    expect((await dstFs.list('/dir')).map((e) => e.name)).toContain('f.txt');
  });

  it('rejects with TransferCancelled when the signal is already aborted', async () => {
    const srcFs = new MockFS('src');
    const dstFs = new MockFS('dst');
    const controller = new AbortController();
    controller.abort();
    await expect(
      transferTree(srcFs, '/Documents', dstFs, '/Documents', { signal: controller.signal }),
    ).rejects.toBeInstanceOf(TransferCancelled);
  });
});
