import {
  FsError,
  sortEntries,
  type FileSystem,
  type FsEntry,
  type ReadHandle,
  type WriteHandle,
} from './FileSystem';

interface Node {
  entry: FsEntry;
  data?: Uint8Array; // files only
}

/** In-memory filesystem used to exercise the shell before real protocols exist. */
export class MockFS implements FileSystem {
  readonly kind = 'mock' as const;
  private nodes = new Map<string, Node>();

  constructor(readonly label = 'Mock') {
    this.seedDir('/');
    this.seedDir('/Documents');
    this.seedDir('/Documents/Projects');
    this.seedFile('/Documents/notes.txt', 'hello world\n');
    this.seedFile('/Documents/budget.xlsx', 'binary-ish');
    this.seedDir('/Pictures');
    this.seedFile('/Pictures/photo.jpg', 'jpegdata');
    this.seedFile('/readme.md', '# readme\n');
  }

  private seedDir(path: string): void {
    const name = path === '/' ? '/' : path.slice(path.lastIndexOf('/') + 1);
    this.nodes.set(path, { entry: { name, path, kind: 'dir', mtime: 0 } });
  }

  private seedFile(path: string, text: string): void {
    const data = new TextEncoder().encode(text);
    const name = path.slice(path.lastIndexOf('/') + 1);
    this.nodes.set(path, {
      entry: { name, path, kind: 'file', size: data.byteLength, mtime: 0 },
      data,
    });
  }

  async list(path: string): Promise<FsEntry[]> {
    const prefix = path === '/' ? '/' : `${path}/`;
    const out: FsEntry[] = [];
    for (const [p, node] of this.nodes) {
      if (p === path) continue;
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (rest.includes('/')) continue; // direct children only
      out.push(node.entry);
    }
    return sortEntries(out);
  }

  async stat(path: string): Promise<FsEntry> {
    const node = this.nodes.get(path);
    if (!node) throw new FsError('not-found', `No such path: ${path}`);
    return node.entry;
  }

  async mkdir(path: string): Promise<void> {
    if (this.nodes.has(path)) throw new FsError('exists', `Exists: ${path}`);
    const name = path.slice(path.lastIndexOf('/') + 1);
    this.nodes.set(path, { entry: { name, path, kind: 'dir', mtime: Date.now() } });
  }

  // NOTE: renaming a directory does NOT rewrite the paths of its children (a mock
  // limitation; real adapters move server-side). The shell renames files, not
  // populated directories, so this is acceptable for the dev double.
  async rename(from: string, to: string): Promise<void> {
    const node = this.nodes.get(from);
    if (!node) throw new FsError('not-found', `No such path: ${from}`);
    this.nodes.delete(from);
    const name = to.slice(to.lastIndexOf('/') + 1);
    node.entry = { ...node.entry, name, path: to };
    this.nodes.set(to, node);
  }

  async remove(path: string, recursive: boolean): Promise<void> {
    if (path === '/') throw new FsError('unsupported', 'Cannot remove the root directory');
    const node = this.nodes.get(path);
    if (!node) throw new FsError('not-found', `No such path: ${path}`);
    if (node.entry.kind === 'dir') {
      const children = await this.list(path);
      if (children.length && !recursive) throw new FsError('not-empty', 'Directory not empty');
      for (const c of children) await this.remove(c.path, true);
    }
    this.nodes.delete(path);
  }

  async move(from: string, to: string): Promise<void> {
    await this.rename(from, to);
  }

  async openRead(path: string, offset = 0): Promise<ReadHandle> {
    const node = this.nodes.get(path);
    if (!node) throw new FsError('not-found', `No such path: ${path}`);
    if (node.entry.kind !== 'file' || !node.data) {
      throw new FsError('not-a-file', `Not a file: ${path}`);
    }
    const data = node.data;
    let cursor = Math.max(0, offset);
    return {
      size: data.byteLength,
      async read(into: Uint8Array): Promise<number> {
        if (cursor >= data.byteLength) return 0;
        const n = Math.min(into.byteLength, data.byteLength - cursor);
        into.set(data.subarray(cursor, cursor + n));
        cursor += n;
        return n;
      },
      async close() {},
    };
  }

  async openWrite(
    path: string,
    _size?: number,
    opts?: { resume?: boolean },
  ): Promise<WriteHandle> {
    const nodes = this.nodes;
    const existing = nodes.get(path);
    const existingData =
      opts?.resume && existing?.entry.kind === 'file' && existing.data ? existing.data : undefined;
    const startOffset = existingData ? existingData.byteLength : 0;

    const chunks: Uint8Array[] = [];
    return {
      startOffset,
      async write(chunk: Uint8Array) {
        chunks.push(chunk.slice());
      },
      async close() {
        const appended = chunks.reduce((n, c) => n + c.byteLength, 0);
        const total = startOffset + appended;
        const data = new Uint8Array(total);
        if (existingData) data.set(existingData, 0);
        let o = startOffset;
        for (const c of chunks) {
          data.set(c, o);
          o += c.byteLength;
        }
        const name = path.slice(path.lastIndexOf('/') + 1);
        nodes.set(path, {
          entry: { name, path, kind: 'file', size: total, mtime: Date.now() },
          data,
        });
      },
      async abort() {
        chunks.length = 0; // never committed unless close() ran
      },
    };
  }
}
