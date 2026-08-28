import { describe, expect, it, vi } from 'vitest';
import { FsError } from '../fs/FileSystem';
import type { FileAttrs } from './attrs';
import { SftpError } from './SftpClient';
import { attrsToEntry, kindFromMode, mapSftpError, SftpFS } from './SftpFS';
import { SSH_FX_NO_SUCH_FILE, SSH_FX_PERMISSION_DENIED } from './constants';

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

function handle(label: string): Uint8Array {
  return new TextEncoder().encode(label);
}

/** Minimal in-memory fake of the SftpClient surface SftpFS drives. */
class FakeSftpClient {
  opendirCalls: string[] = [];
  readdirCalls: Uint8Array[] = [];
  closeHandleCalls: Uint8Array[] = [];
  statCalls: string[] = [];
  removeCalls: string[] = [];
  rmdirCalls: string[] = [];
  mkdirCalls: { path: string; attrs: FileAttrs }[] = [];
  renameCalls: { from: string; to: string }[] = [];
  setstatCalls: { path: string; attrs: FileAttrs }[] = [];
  openCalls: { path: string; pflags: number }[] = [];
  writeCalls: { handle: Uint8Array; offset: number; data: Uint8Array }[] = [];
  readCalls: { handle: Uint8Array; offset: number; length: number }[] = [];

  // ---- configurable behavior ----
  private readdirBatches: ({ filename: string; longname: string; attrs: FileAttrs }[] | null)[] = [];
  private statResult: FileAttrs | Error = {};
  private readChunks: (Uint8Array | null)[] = [];

  setReaddirBatches(batches: ({ filename: string; longname: string; attrs: FileAttrs }[] | null)[]): void {
    this.readdirBatches = [...batches];
  }

  setStatResult(result: FileAttrs | Error): void {
    this.statResult = result;
  }

  setReadChunks(chunks: (Uint8Array | null)[]): void {
    this.readChunks = [...chunks];
  }

  async opendir(path: string): Promise<Uint8Array> {
    this.opendirCalls.push(path);
    return handle('dir-handle');
  }

  async readdir(h: Uint8Array) {
    this.readdirCalls.push(h);
    const next = this.readdirBatches.shift();
    return next === undefined ? null : next;
  }

  async closeHandle(h: Uint8Array): Promise<void> {
    this.closeHandleCalls.push(h);
  }

  async stat(path: string): Promise<FileAttrs> {
    this.statCalls.push(path);
    if (this.statResult instanceof Error) throw this.statResult;
    return this.statResult;
  }

  async mkdir(path: string, attrs: FileAttrs): Promise<void> {
    this.mkdirCalls.push({ path, attrs });
  }

  async rename(from: string, to: string): Promise<void> {
    this.renameCalls.push({ from, to });
  }

  async remove(path: string): Promise<void> {
    this.removeCalls.push(path);
  }

  async rmdir(path: string): Promise<void> {
    this.rmdirCalls.push(path);
  }

  async setstat(path: string, attrs: FileAttrs): Promise<void> {
    this.setstatCalls.push({ path, attrs });
  }

  async open(path: string, pflags: number): Promise<Uint8Array> {
    this.openCalls.push({ path, pflags });
    return handle('file-handle');
  }

  async read(h: Uint8Array, offset: number, length: number): Promise<Uint8Array | null> {
    this.readCalls.push({ handle: h, offset, length });
    const next = this.readChunks.shift();
    return next === undefined ? null : next;
  }

  async write(h: Uint8Array, offset: number, data: Uint8Array): Promise<void> {
    this.writeCalls.push({ handle: h, offset, data });
  }
}

function makeFS(client: FakeSftpClient): SftpFS {
  return new SftpFS(client as never, 'test');
}

describe('kindFromMode', () => {
  it('maps dir/symlink/file/undefined', () => {
    expect(kindFromMode(S_IFDIR | 0o755)).toBe('dir');
    expect(kindFromMode(0o120000 | 0o777)).toBe('symlink');
    expect(kindFromMode(S_IFREG | 0o644)).toBe('file');
    expect(kindFromMode(undefined)).toBe('file');
  });
});

describe('attrsToEntry', () => {
  it('maps size/mtime(s->ms)/mode', () => {
    const entry = attrsToEntry('a.txt', '/dir/a.txt', {
      size: 42,
      mtime: 1000,
      permissions: S_IFREG | 0o644,
    });
    expect(entry).toMatchObject({
      name: 'a.txt',
      path: '/dir/a.txt',
      kind: 'file',
      size: 42,
      mtime: 1000000,
      mode: 0o644,
    });
  });

  it('leaves mtime undefined when absent', () => {
    const entry = attrsToEntry('a', '/a', {});
    expect(entry.mtime).toBeUndefined();
    expect(entry.mode).toBeUndefined();
  });
});

describe('SftpFS.list', () => {
  it('skips . and .., maps kind/size/mtime, sorts folders first, closes handle', async () => {
    const client = new FakeSftpClient();
    client.setReaddirBatches([
      [
        { filename: 'a.txt', longname: '', attrs: { size: 10, mtime: 5, permissions: S_IFREG | 0o644 } },
        { filename: 'sub', longname: '', attrs: { permissions: S_IFDIR | 0o755 } },
        { filename: '.', longname: '', attrs: {} },
        { filename: '..', longname: '', attrs: {} },
      ],
    ]);
    const fs = makeFS(client);

    const entries = await fs.list('/dir');

    expect(entries.map((e) => e.name)).toEqual(['sub', 'a.txt']);
    expect(entries[0].kind).toBe('dir');
    expect(entries[1].kind).toBe('file');
    expect(entries[1].size).toBe(10);
    expect(entries[1].mtime).toBe(5000);
    expect(entries[1].path).toBe('/dir/a.txt');
    expect(client.opendirCalls).toEqual(['/dir']);
    expect(client.closeHandleCalls).toHaveLength(1);
  });

  it('closes the handle even when readdir throws', async () => {
    const client = new FakeSftpClient();
    client.readdir = vi.fn().mockRejectedValue(new Error('boom'));
    const fs = makeFS(client);

    await expect(fs.list('/dir')).rejects.toThrow();
    expect(client.closeHandleCalls).toHaveLength(1);
  });
});

describe('SftpFS.stat', () => {
  it('maps dir mode', async () => {
    const client = new FakeSftpClient();
    client.setStatResult({ permissions: S_IFDIR | 0o755 });
    const fs = makeFS(client);
    const entry = await fs.stat('/dir');
    expect(entry.kind).toBe('dir');
    expect(entry.name).toBe('dir');
    expect(entry.mode).toBe(0o755);
  });

  it('maps file mode', async () => {
    const client = new FakeSftpClient();
    client.setStatResult({ permissions: S_IFREG | 0o644, size: 5 });
    const fs = makeFS(client);
    const entry = await fs.stat('/a/f.txt');
    expect(entry.kind).toBe('file');
    expect(entry.name).toBe('f.txt');
    expect(entry.mode).toBe(0o644);
  });
});

describe('SftpFS.remove', () => {
  it('throws not-empty for a non-empty dir without recursive', async () => {
    const client = new FakeSftpClient();
    client.setStatResult({ permissions: S_IFDIR | 0o755 });
    client.setReaddirBatches([[{ filename: 'child', longname: '', attrs: { permissions: S_IFREG } }]]);
    const fs = makeFS(client);

    await expect(fs.remove('/d', false)).rejects.toMatchObject({ code: 'not-empty' });
  });

  it('recurses into children and rmdirs when recursive', async () => {
    const client = new FakeSftpClient();
    // First stat: the top dir. Then, inside remove(child), another stat for the child.
    let statCall = 0;
    client.stat = vi.fn(async (path: string) => {
      statCall++;
      client.statCalls.push(path);
      if (statCall === 1) return { permissions: S_IFDIR | 0o755 };
      return { permissions: S_IFREG | 0o644 };
    });
    client.setReaddirBatches([[{ filename: 'child', longname: '', attrs: { permissions: S_IFREG } }], []]);
    const fs = makeFS(client);

    await fs.remove('/d', true);

    expect(client.removeCalls).toEqual(['/d/child']);
    expect(client.rmdirCalls).toEqual(['/d']);
  });

  it('removes a plain file directly', async () => {
    const client = new FakeSftpClient();
    client.setStatResult({ permissions: S_IFREG | 0o644 });
    const fs = makeFS(client);

    await fs.remove('/f.txt', false);

    expect(client.removeCalls).toEqual(['/f.txt']);
    expect(client.rmdirCalls).toEqual([]);
  });
});

describe('SftpFS.openRead', () => {
  it('collects bytes across chunks and returns 0 at EOF, advancing offsets', async () => {
    const client = new FakeSftpClient();
    const chunk1 = new Uint8Array([1, 2, 3]);
    const chunk2 = new Uint8Array([4, 5]);
    client.setReadChunks([chunk1, chunk2, null]);
    const fs = makeFS(client);

    const rh = await fs.openRead('/f.bin');
    const buf = new Uint8Array(16);
    const collected: number[] = [];

    let n = await rh.read(buf);
    collected.push(...buf.subarray(0, n));
    n = await rh.read(buf);
    collected.push(...buf.subarray(0, n));
    n = await rh.read(buf);
    expect(n).toBe(0);

    await rh.close();

    expect(collected).toEqual([1, 2, 3, 4, 5]);
    expect(client.readCalls.map((c) => c.offset)).toEqual([0, 3, 5]);
    expect(client.closeHandleCalls).toHaveLength(1);
  });
});

describe('SftpFS.openWrite', () => {
  it('writes chunks at advancing offsets and closes', async () => {
    const client = new FakeSftpClient();
    const fs = makeFS(client);

    const wh = await fs.openWrite('/out.bin');
    const chunk1 = new Uint8Array([1, 2, 3, 4]);
    const chunk2 = new Uint8Array([5, 6]);
    await wh.write(chunk1);
    await wh.write(chunk2);
    await wh.close();

    expect(client.writeCalls[0].offset).toBe(0);
    expect(client.writeCalls[0].data).toEqual(chunk1);
    expect(client.writeCalls[1].offset).toBe(4);
    expect(client.writeCalls[1].data).toEqual(chunk2);
    expect(client.closeHandleCalls).toHaveLength(1);
  });
});

describe('error mapping', () => {
  it('mapSftpError maps SftpError codes and passes through FsError', () => {
    expect(mapSftpError(new SftpError(SSH_FX_NO_SUCH_FILE, 'nope')).code).toBe('not-found');
    expect(mapSftpError(new SftpError(SSH_FX_PERMISSION_DENIED, 'nope')).code).toBe('permission');
    expect(mapSftpError(new SftpError(4, 'nope')).code).toBe('io');
    const fsErr = new FsError('not-empty', 'x');
    expect(mapSftpError(fsErr)).toBe(fsErr);
    expect(mapSftpError(new Error('other')).code).toBe('io');
  });

  it('SftpFS.stat rejects with FsError not-found on NO_SUCH_FILE', async () => {
    const client = new FakeSftpClient();
    client.setStatResult(new SftpError(SSH_FX_NO_SUCH_FILE, 'no such file'));
    const fs = makeFS(client);

    await expect(fs.stat('/missing')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('SftpFS.stat rejects with FsError permission on PERMISSION_DENIED', async () => {
    const client = new FakeSftpClient();
    client.setStatResult(new SftpError(SSH_FX_PERMISSION_DENIED, 'denied'));
    const fs = makeFS(client);

    await expect(fs.stat('/secret')).rejects.toMatchObject({ code: 'permission' });
  });
});
