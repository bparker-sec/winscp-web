import {
  FsError,
  joinPath,
  parentPath,
  sortEntries,
  type FileSystem,
  type FsEntry,
  type ReadHandle,
  type WriteHandle,
} from '../fs/FileSystem';
import {
  GraphError,
  type Authable,
  createFolder,
  createUploadSession,
  cancelUpload,
  deleteItem,
  downloadRange,
  driveItemToEntry,
  getItem,
  listChildren,
  patchItem,
  putUploadChunk,
  uploadSmall,
} from './graph';

const ALIGN = 320 * 1024; // Graph requires upload chunks to be multiples of 320 KiB
const FLUSH_AT = 10 * ALIGN; // ~3.2 MB buffered before a streamed flush
const SIMPLE_LIMIT = 4 * 1024 * 1024; // <=4 MB -> single PUT

function mapError(e: unknown): FsError {
  if (e instanceof FsError) return e;
  if (e instanceof GraphError) {
    const code =
      e.status === 404
        ? 'not-found'
        : e.status === 409
          ? 'exists'
          : e.status === 403
            ? 'permission'
            : 'io';
    return new FsError(code, e.message, e);
  }
  return new FsError('io', e instanceof Error ? e.message : String(e), e);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

/** OneDrive file system, addressing items by POSIX path via Microsoft Graph. */
export class OneDriveFS implements FileSystem {
  readonly kind = 'onedrive' as const;

  constructor(
    private readonly auth: Authable,
    readonly label = 'OneDrive',
  ) {}

  async list(path: string): Promise<FsEntry[]> {
    try {
      const items = await listChildren(this.auth, path);
      return sortEntries(items.map((it) => driveItemToEntry(it, joinPath(path, it.name))));
    } catch (e) {
      throw mapError(e);
    }
  }

  async stat(path: string): Promise<FsEntry> {
    try {
      const item = await getItem(this.auth, path);
      return driveItemToEntry(item, path);
    } catch (e) {
      throw mapError(e);
    }
  }

  async mkdir(path: string): Promise<void> {
    try {
      await createFolder(this.auth, parentPath(path), basename(path));
    } catch (e) {
      throw mapError(e);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    try {
      const changes: { name?: string; newParentPath?: string } = {};
      if (basename(from) !== basename(to)) changes.name = basename(to);
      if (parentPath(from) !== parentPath(to)) changes.newParentPath = parentPath(to);
      if (Object.keys(changes).length) await patchItem(this.auth, from, changes);
    } catch (e) {
      throw mapError(e);
    }
  }

  async move(from: string, to: string): Promise<void> {
    return this.rename(from, to);
  }

  async remove(path: string, recursive: boolean): Promise<void> {
    try {
      const item = await getItem(this.auth, path);
      if (item.folder && !recursive && (item.folder.childCount ?? 0) > 0) {
        throw new FsError('not-empty', `Directory not empty: ${path}`);
      }
      await deleteItem(this.auth, path);
    } catch (e) {
      throw mapError(e);
    }
  }

  async openRead(path: string): Promise<ReadHandle> {
    let size: number;
    try {
      const item = await getItem(this.auth, path);
      if (item.folder) throw new FsError('not-a-file', `Not a file: ${path}`);
      size = item.size ?? 0;
    } catch (e) {
      throw mapError(e);
    }
    const auth = this.auth;
    let offset = 0;
    return {
      size,
      async read(into: Uint8Array): Promise<number> {
        if (offset >= size) return 0;
        const want = Math.min(into.byteLength, size - offset);
        try {
          const buf = await downloadRange(auth, path, offset, offset + want - 1);
          const bytes = new Uint8Array(buf);
          into.set(bytes.subarray(0, want));
          const got = Math.min(bytes.byteLength, want);
          offset += got;
          return got;
        } catch (e) {
          throw mapError(e);
        }
      },
      async close() {},
    };
  }

  async openWrite(path: string, size?: number): Promise<WriteHandle> {
    const auth = this.auth;
    // Unknown length: buffer, then upload on close.
    if (size === undefined) {
      const parts: Uint8Array[] = [];
      return {
        async write(chunk) {
          parts.push(chunk.slice());
        },
        async close() {
          const data = concat(parts);
          try {
            if (data.byteLength <= SIMPLE_LIMIT) {
              await uploadSmall(auth, path, data);
            } else {
              const url = await createUploadSession(auth, path);
              for (let o = 0; o < data.byteLength; o += FLUSH_AT) {
                await putUploadChunk(
                  url,
                  data.subarray(o, Math.min(o + FLUSH_AT, data.byteLength)),
                  o,
                  data.byteLength,
                );
              }
            }
          } catch (e) {
            throw mapError(e);
          }
        },
        async abort() {},
      };
    }

    // Known length: stream to a resumable session in 320 KiB-aligned chunks.
    let url: string | null = null;
    let pending: Uint8Array = new Uint8Array(0);
    let sent = 0;
    const total = size;
    const ensure = async () => {
      if (!url) url = await createUploadSession(auth, path);
      return url;
    };
    return {
      // Callers must await each write() before the next; memory stays bounded to
      // roughly one caller chunk + FLUSH_AT.
      async write(chunk) {
        try {
          pending = concat([pending, chunk]);
          if (total <= SIMPLE_LIMIT) return; // small file: single PUT at close()
          if (pending.byteLength < FLUSH_AT) return; // batch PUTs to ~FLUSH_AT
          let flush = Math.floor(pending.byteLength / ALIGN) * ALIGN;
          // Never flush the block that would complete the session — reserve the
          // final aligned block (and any tail) for close().
          if (sent + flush >= total) {
            const remaining = total - sent;
            flush = Math.max(0, Math.floor((remaining - 1) / ALIGN) * ALIGN);
          }
          if (flush >= ALIGN) {
            const u = await ensure();
            await putUploadChunk(u, pending.subarray(0, flush), sent, total);
            sent += flush;
            pending = pending.slice(flush);
          }
        } catch (e) {
          throw mapError(e);
        }
      },
      async close() {
        try {
          if (total <= SIMPLE_LIMIT) {
            await uploadSmall(auth, path, pending);
            return;
          }
          const u = await ensure();
          // Final chunk (may be unaligned) completes the session.
          await putUploadChunk(u, pending, sent, total);
        } catch (e) {
          throw mapError(e);
        }
      },
      async abort() {
        if (url) await cancelUpload(url);
      },
    };
  }
}
