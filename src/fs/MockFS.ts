import {
  joinPath,
  parentPath,
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
    this.nodes.set(path, {
      entry: { name, path, kind: 'dir', mtime: 0 },
    });
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
    if (!node) throw new Error(`No such path: ${path}`);
    return node.entry;
  }

  async mkdir(path: string): Promise<void> {
    if (this.nodes.has(path)) throw new Error(`Exists: ${path}`);
    const name = path.slice(path.lastIndexOf('/') + 1);
    this.nodes.set(path, { entry: { name, path, kind: 'dir', mtime: Date.now() } });
  }

  async rename(from: string, to: string): Promise<void> {
    const node = this.nodes.get(from);
    if (!node) throw new Error(`No such path: ${from}`);
    this.nodes.delete(from);
    const name = to.slice(to.lastIndexOf('/') + 1);
    node.entry = { ...node.entry, name, path: to };
    this.nodes.set(to, node);
  }

  async remove(path: string, recursive: boolean): Promise<void> {
    const node = this.nodes.get(path);
    if (!node) throw new Error(`No such path: ${path}`);
    if (node.entry.kind === 'dir') {
      const children = await this.list(path);
      if (children.length && !recursive) throw new Error('Directory not empty');
      for (const c of children) await this.remove(c.path, true);
    }
    this.nodes.delete(path);
  }

  async move(from: string, to: string): Promise<void> {
    await this.rename(from, to);
  }

  async openRead(path: string): Promise<ReadHandle> {
    const node = this.nodes.get(path);
    if (!node || node.entry.kind !== 'file' || !node.data) {
      throw new Error(`Not a file: ${path}`);
    }
    const data = node.data;
    let offset = 0;
    return {
      size: data.byteLength,
      async read(into: Uint8Array): Promise<number> {
        if (offset >= data.byteLength) return 0;
        const n = Math.min(into.byteLength, data.byteLength - offset);
        into.set(data.subarray(offset, offset + n));
        offset += n;
        return n;
      },
      async close() {},
    };
  }

  async openWrite(path: string): Promise<WriteHandle> {
    const chunks: Uint8Array[] = [];
    const nodes = this.nodes;
    return {
      async write(chunk: Uint8Array) {
        chunks.push(chunk.slice());
      },
      async close() {
        const total = chunks.reduce((n, c) => n + c.byteLength, 0);
        const data = new Uint8Array(total);
        let o = 0;
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
    };
  }
}

// Re-export helpers consumers expect from here for convenience.
export { joinPath, parentPath };
