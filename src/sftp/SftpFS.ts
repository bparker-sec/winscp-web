// FileSystem implementation over an SftpClient.

import { FsError, joinPath, sortEntries, type FileSystem, type FsEntry, type ReadHandle, type WriteHandle } from '../fs/FileSystem';
import type { SftpClient } from './SftpClient';
import { SftpError } from './SftpClient';
import type { FileAttrs } from './attrs';
import { MAX_SFTP_PAYLOAD, SSH_FX_FAILURE, SSH_FX_NO_SUCH_FILE, SSH_FX_OP_UNSUPPORTED, SSH_FX_PERMISSION_DENIED, SSH_FXF_CREAT, SSH_FXF_READ, SSH_FXF_TRUNC, SSH_FXF_WRITE } from './constants';

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

/** Normalize a caller-supplied pipeline depth to a sane integer >= 1 (default 1). */
function clampDepth(depth: number | undefined): number {
  if (typeof depth !== 'number' || !Number.isFinite(depth)) return 1;
  return Math.max(1, Math.floor(depth));
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

  async openRead(
    path: string,
    initialOffset = 0,
    opts?: { pipelineDepth?: number },
  ): Promise<ReadHandle> {
    try {
      const handle = await this.client.open(path, SSH_FXF_READ);
      const client = this.client;
      const depth = clampDepth(opts?.pipelineDepth);

      // Read-ahead: keep up to `depth` READ requests in flight at successive
      // fixed-stride offsets so a high-latency link isn't stalled one round-trip
      // per chunk. Responses are consumed in issue order (reads are
      // offset-addressed, so completion order is irrelevant). `reqLen` is fixed
      // at the caller's first buffer size (the engine uses one buffer per file),
      // capped to the SFTP message limit.
      //
      // Short-read safety: SFTP servers normally return exactly `reqLen` bytes
      // until EOF, but the spec permits a short read mid-file. If one occurs, the
      // speculative reads we already issued are at now-wrong offsets, so we
      // discard them and resync requests to the true byte position. A null/empty
      // read is EOF. Full reads keep the pipeline topped up.
      let inflight: { at: number; p: Promise<Uint8Array | null> }[] = [];
      let reqOffset = initialOffset;
      let reqLen = 0;
      let eof = false;
      let leftover: Uint8Array | null = null;

      const topUp = () => {
        while (!eof && inflight.length < depth) {
          const at = reqOffset;
          reqOffset += reqLen;
          inflight.push({ at, p: client.read(handle, at, reqLen) });
        }
      };

      return {
        async read(into: Uint8Array): Promise<number> {
          try {
            // Serve any bytes left over from a chunk larger than a prior `into`.
            if (leftover && leftover.length > 0) {
              const n = Math.min(leftover.length, into.byteLength);
              into.set(leftover.subarray(0, n));
              leftover = n < leftover.length ? leftover.subarray(n) : null;
              return n;
            }
            if (reqLen === 0) reqLen = Math.min(into.byteLength, MAX_SFTP_PAYLOAD) || MAX_SFTP_PAYLOAD;
            topUp();
            if (inflight.length === 0) return 0;
            const item = inflight.shift()!;
            const chunk = await item.p;
            if (chunk === null || chunk.length === 0) {
              eof = true;
              inflight = []; // abandon any speculative reads past EOF
              return 0;
            }
            if (chunk.length < reqLen) {
              // Short read: the reads we prefetched assumed a full chunk, so
              // their offsets are wrong. Drop them and resync to just past what
              // we actually got; the next read re-issues from there (and returns
              // 0 if this short read was in fact EOF).
              inflight = [];
              reqOffset = item.at + chunk.length;
            } else {
              topUp();
            }
            const n = Math.min(chunk.length, into.byteLength);
            into.set(chunk.subarray(0, n));
            if (n < chunk.length) leftover = chunk.subarray(n);
            return n;
          } catch (e) {
            eof = true;
            inflight = [];
            throw mapSftpError(e);
          }
        },
        async close(): Promise<void> {
          // Let any in-flight reads settle so their handle references are done
          // before we close it; ignore their results.
          await Promise.allSettled(inflight.map((i) => i.p));
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

  async openWrite(
    path: string,
    _size?: number,
    opts?: { resume?: boolean; pipelineDepth?: number },
  ): Promise<WriteHandle> {
    try {
      const client = this.client;
      const depth = clampDepth(opts?.pipelineDepth);
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

      // Pipelined writes: issue up to `depth` WRITE requests without waiting for
      // each STATUS, so a high-latency link stays saturated instead of paying a
      // round-trip per chunk. WRITEs are offset-addressed, so completion order
      // doesn't matter. Backpressure: once `depth` are outstanding, wait for the
      // oldest before accepting more. depth=1 is exactly the old serial path.
      const inflight: Promise<void>[] = [];
      let failure: unknown = null;

      const issue = (at: number, data: Uint8Array): void => {
        const p = client.write(handle, at, data).catch((e) => {
          if (failure === null) failure = e;
        });
        inflight.push(p);
      };

      return {
        startOffset,
        async write(chunk: Uint8Array): Promise<void> {
          if (failure !== null) throw mapSftpError(failure);
          // Split into sub-chunks within a single SFTP message. A WRITE larger
          // than the server's cap (OpenSSH: 256 KiB total, header included)
          // makes sftp-server abort the whole channel.
          for (let pos = 0; pos < chunk.length; pos += MAX_SFTP_PAYLOAD) {
            const slice = chunk.subarray(pos, pos + MAX_SFTP_PAYLOAD);
            // Copy: the caller reuses its buffer as soon as write() returns, but
            // a pipelined WRITE may not have hit the wire yet.
            issue(offset, slice.slice());
            offset += slice.length;
            if (inflight.length >= depth) {
              await inflight.shift();
              if (failure !== null) throw mapSftpError(failure);
            }
          }
        },
        async close(): Promise<void> {
          // Each issued write's rejection is captured into `failure` (never
          // rejects the tracked promise), so draining can't throw here.
          await Promise.all(inflight);
          inflight.length = 0;
          if (failure !== null) {
            await client.closeHandle(handle).catch(() => {});
            throw mapSftpError(failure);
          }
          try {
            await client.closeHandle(handle);
          } catch (e) {
            throw mapSftpError(e);
          }
        },
        async abort(): Promise<void> {
          await Promise.allSettled(inflight);
          inflight.length = 0;
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
