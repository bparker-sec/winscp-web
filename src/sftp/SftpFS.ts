// FileSystem implementation over an SftpClient.

import { FsError, joinPath, sortEntries, type FileSystem, type FsEntry, type ReadHandle, type WriteHandle } from '../fs/FileSystem';
import type { SftpClient } from './SftpClient';
import { SftpError } from './SftpClient';
import type { FileAttrs } from './attrs';
import { SSH_FX_FAILURE, SSH_FX_NO_SUCH_FILE, SSH_FX_OP_UNSUPPORTED, SSH_FX_PERMISSION_DENIED, SSH_FXF_CREAT, SSH_FXF_READ, SSH_FXF_TRUNC, SSH_FXF_WRITE } from './constants';

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

/** Map any error raised while talking to an SftpClient into an FsError. */
export function mapSftpError(e: unknown): FsError {
  if (e instanceof FsError) return e;
  if (e instanceof SftpError) {
    switch (e.code) {
      case SSH_FX_NO_SUCH_FILE:
        return new FsError('not-found', e.message, e);
      case SSH_FX_PERMISSION_DENIED:
        return new FsError('permission', e.message, e);
      case SSH_FX_OP_UNSUPPORTED:
        return new FsError('unsupported', e.message, e);
      default:
        return new FsError('io', e.message, e);
    }
  }
  const message = e instanceof Error ? e.message : String(e);
  return new FsError('io', message, e);
}

/** POSIX file kind from the `permissions` mode bits, defaulting to 'file' when unknown. */
export function kindFromMode(mode?: number): FsEntry['kind'] {
  if (mode === undefined) return 'file';
  const type = mode & S_IFMT;
  if (type === S_IFDIR) return 'dir';
  if (type === S_IFLNK) return 'symlink';
  return 'file';
}

/** Map SFTP FileAttrs to the protocol-agnostic FsEntry shape. */
export function attrsToEntry(name: string, path: string, attrs: FileAttrs): FsEntry {
  return {
    name,
    path,
    kind: kindFromMode(attrs.permissions),
    size: attrs.size,
    mtime: attrs.mtime !== undefined ? attrs.mtime * 1000 : undefined,
    mode: attrs.permissions !== undefined ? attrs.permissions & 0o7777 : undefined,
    raw: attrs,
  };
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export class SftpFS implements FileSystem {
  readonly kind = 'sftp' as const;

  constructor(
    private readonly client: SftpClient,
    readonly label = 'sftp',
  ) {}

  async list(path: string): Promise<FsEntry[]> {
    try {
      const handle = await this.client.opendir(path);
      const entries: FsEntry[] = [];
      try {
        for (;;) {
          const batch = await this.client.readdir(handle);
          if (batch === null) break;
          for (const { filename, attrs } of batch) {
            if (filename === '.' || filename === '..') continue;
            entries.push(attrsToEntry(filename, joinPath(path, filename), attrs));
          }
        }
      } finally {
        await this.client.closeHandle(handle);
      }
      return sortEntries(entries);
    } catch (e) {
      throw mapSftpError(e);
    }
  }

  async stat(path: string): Promise<FsEntry> {
    try {
      const attrs = await this.client.stat(path);
      return attrsToEntry(basename(path), path, attrs);
    } catch (e) {
      throw mapSftpError(e);
    }
  }

  async mkdir(path: string): Promise<void> {
    try {
      await this.client.mkdir(path, {});
    } catch (e) {
      // SFTP servers typically return SSH_FX_FAILURE (not a dedicated code) when
      // the target already exists. Disambiguate by stat to honor the FileSystem
      // contract's FsError('exists').
      if (e instanceof SftpError && e.code === SSH_FX_FAILURE) {
        const exists = await this.client.stat(path).then(() => true).catch(() => false);
        if (exists) throw new FsError('exists', `Already exists: ${path}`);
      }
      throw mapSftpError(e);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    try {
      await this.client.rename(from, to);
    } catch (e) {
      throw mapSftpError(e);
    }
  }

  async move(from: string, to: string): Promise<void> {
    try {
      await this.client.rename(from, to);
    } catch (e) {
      throw mapSftpError(e);
    }
  }

  async remove(path: string, recursive: boolean): Promise<void> {
    try {
      const attrs = await this.client.stat(path);
      if (kindFromMode(attrs.permissions) === 'dir') {
        const children = await this.list(path);
        if (children.length > 0 && !recursive) {
          throw new FsError('not-empty', `Directory not empty: ${path}`);
        }
        for (const child of children) {
          await this.remove(child.path, true);
        }
        await this.client.rmdir(path);
      } else {
        await this.client.remove(path);
      }
    } catch (e) {
      throw mapSftpError(e);
    }
  }

  async openRead(path: string, initialOffset = 0): Promise<ReadHandle> {
    try {
      const handle = await this.client.open(path, SSH_FXF_READ);
      const client = this.client;
      let offset = initialOffset;
      return {
        async read(into: Uint8Array): Promise<number> {
          try {
            const chunk = await client.read(handle, offset, into.byteLength);
            if (chunk === null) return 0;
            const n = Math.min(chunk.length, into.byteLength);
            into.set(chunk.subarray(0, n));
            offset += n;
            return n;
          } catch (e) {
            throw mapSftpError(e);
          }
        },
        async close(): Promise<void> {
          try {
            await client.closeHandle(handle);
          } catch (e) {
            throw mapSftpError(e);
          }
        },
      };
    } catch (e) {
      throw mapSftpError(e);
    }
  }

  async openWrite(path: string, _size?: number, opts?: { resume?: boolean }): Promise<WriteHandle> {
    try {
      const client = this.client;
      let startOffset = 0;
      let pflags = SSH_FXF_WRITE | SSH_FXF_CREAT | SSH_FXF_TRUNC;

      if (opts?.resume) {
        try {
          const attrs = await client.stat(path);
          startOffset = attrs.size ?? 0;
        } catch (e) {
          if (e instanceof SftpError && e.code === SSH_FX_NO_SUCH_FILE) {
            startOffset = 0;
          } else {
            throw e;
          }
        }
        // Never TRUNC when resuming — that would wipe the partial we're
        // continuing from.
        pflags = SSH_FXF_WRITE | SSH_FXF_CREAT;
      }

      const handle = await client.open(path, pflags);
      let offset = startOffset;
      return {
        startOffset,
        async write(chunk: Uint8Array): Promise<void> {
          try {
            await client.write(handle, offset, chunk);
            offset += chunk.length;
          } catch (e) {
            throw mapSftpError(e);
          }
        },
        async close(): Promise<void> {
          try {
            await client.closeHandle(handle);
          } catch (e) {
            throw mapSftpError(e);
          }
        },
        async abort(): Promise<void> {
          try {
            await client.closeHandle(handle);
          } catch {
            // best-effort; partial file remains on the server.
          }
        },
      };
    } catch (e) {
      throw mapSftpError(e);
    }
  }

  async chmod(path: string, mode: number): Promise<void> {
    try {
      await this.client.setstat(path, { permissions: mode });
    } catch (e) {
      throw mapSftpError(e);
    }
  }
}
