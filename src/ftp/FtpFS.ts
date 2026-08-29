// FileSystem implementation over an FtpClient (RFC 959 + MLSD/EPSV extensions).
//
// FTP has a single control connection and one transfer at a time, so every
// public method runs under the client's lock. Internal `_`-prefixed helpers
// assume the lock is already held and call each other freely (e.g. recursive
// remove -> list -> remove) without re-locking. openRead/openWrite hold the lock
// across the returned handle's whole lifetime and release it on close()/abort().

import {
  FsError,
  parentPath,
  sortEntries,
  type FileSystem,
  type FsEntry,
  type ReadHandle,
  type WriteHandle,
} from '../fs/FileSystem';
import { FtpClient, ftpError } from './FtpConnection';
import { parseMlsdLine, parseListLine, parseSize, type FtpReply } from './parse';

// Re-export the pure parser helpers so consumers/tests can import them from a
// single FTP surface.
export {
  parseReply,
  parseReplyLine,
  parseEpsv,
  parsePasv,
  parseMlsdLine,
  parseListLine,
  parsePwd,
  parseModifyTime,
  parseSize,
  permsToMode,
  parseLsDate,
  isPrivateIp,
  resolveDataHost,
} from './parse';

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i < 0 ? trimmed : trimmed.slice(i + 1);
}

function asFsError(e: unknown): FsError {
  if (e instanceof FsError) return e;
  return new FsError('io', e instanceof Error ? e.message : String(e), e);
}

/** True for reply codes meaning "command not implemented / not supported". */
function isUnsupported(reply: FtpReply): boolean {
  return reply.code === 500 || reply.code === 501 || reply.code === 502 || reply.code === 504;
}

/** A transfer command opened its data connection when it replies 150 or 125. */
function transferStarted(reply: FtpReply): boolean {
  return reply.code === 150 || reply.code === 125;
}

const TEXT = new TextDecoder();

export class FtpFS implements FileSystem {
  readonly kind = 'ftp' as const;

  constructor(
    private readonly client: FtpClient,
    readonly label = 'ftp',
  ) {}

  // ---- public API (each takes the lock) ----

  list(path: string): Promise<FsEntry[]> {
    return this.client.withLock(() => this._list(path)).catch((e) => {
      throw asFsError(e);
    });
  }

  stat(path: string): Promise<FsEntry> {
    return this.client.withLock(() => this._stat(path)).catch((e) => {
      throw asFsError(e);
    });
  }

  mkdir(path: string): Promise<void> {
    return this.client.withLock(() => this._mkdir(path)).catch((e) => {
      throw asFsError(e);
    });
  }

  rename(from: string, to: string): Promise<void> {
    return this.client.withLock(() => this._rename(from, to)).catch((e) => {
      throw asFsError(e);
    });
  }

  move(from: string, to: string): Promise<void> {
    return this.rename(from, to);
  }

  remove(path: string, recursive: boolean): Promise<void> {
    return this.client.withLock(() => this._remove(path, recursive)).catch((e) => {
      throw asFsError(e);
    });
  }

  // ---- internal helpers (lock already held) ----

  private async _list(path: string): Promise<FsEntry[]> {
    // CWD into the directory first, then list the current dir. 550 => not-found.
    const cwd = await this.client.command(`CWD ${path}`);
    if (cwd.code !== 250) throw ftpError(cwd, `CWD ${path}`);

    // Preferred: MLSD (machine-readable). Open a passive data conn, then issue
    // MLSD; on a 5xx "unsupported" fall back to LIST on a fresh data conn.
    let data = await this.client.openPassive();
    let reply = await this.client.command('MLSD');
    let useMlsd = true;
    if (!transferStarted(reply)) {
      if (isUnsupported(reply)) {
        await data.close().catch(() => undefined);
        data = await this.client.openPassive();
        reply = await this.client.command('LIST');
        useMlsd = false;
        if (!transferStarted(reply)) {
          await data.close().catch(() => undefined);
          throw ftpError(reply, 'LIST');
        }
      } else {
        await data.close().catch(() => undefined);
        throw ftpError(reply, 'MLSD');
      }
    }

    const bytes = await data.readAll();
    await data.close().catch(() => undefined);
    const done = await this.client.readReply();
    if (done.code !== 226 && done.code !== 250) throw ftpError(done, useMlsd ? 'MLSD' : 'LIST');

    const lines = TEXT.decode(bytes).split(/\r?\n/);
    const entries: FsEntry[] = [];
    for (const line of lines) {
      if (!line) continue;
      const entry = useMlsd ? parseMlsdLine(line, path) : parseListLine(line, path);
      if (entry) entries.push(entry);
    }
    return sortEntries(entries);
  }

  private async _stat(path: string): Promise<FsEntry> {
    if (path === '' || path === '/') {
      return { name: '', path: '/', kind: 'dir' };
    }
    const reply = await this.client.command(`MLST ${path}`);
    if (reply.code === 250) {
      // The fact line is the one indented with a leading space.
      const factLine = reply.lines.find((l) => /^\s/.test(l)) ?? reply.lines[1];
      if (factLine) {
        const parsed = parseMlsdLine(factLine.replace(/^\s+/, ''), parentPath(path));
        if (parsed) {
          return { ...parsed, name: basename(path), path };
        }
      }
    }
    if (isUnsupported(reply)) {
      // Fallback: list the parent and find the entry by name.
      const parent = parentPath(path);
      const name = basename(path);
      const entries = await this._list(parent);
      const found = entries.find((e) => e.name === name);
      if (found) return found;
      throw new FsError('not-found', `Not found: ${path}`);
    }
    throw ftpError(reply, `MLST ${path}`);
  }

  private async _mkdir(path: string): Promise<void> {
    const reply = await this.client.command(`MKD ${path}`);
    if (reply.code === 257) return;
    if (reply.code === 550 || reply.code === 553) {
      // Disambiguate "already exists" (=> 'exists') from "parent missing".
      const exists = await this._exists(path);
      if (exists) throw new FsError('exists', `Already exists: ${path}`);
    }
    throw ftpError(reply, `MKD ${path}`);
  }

  private async _exists(path: string): Promise<boolean> {
    const mlst = await this.client.command(`MLST ${path}`);
    if (mlst.code === 250) return true;
    if (mlst.code === 550) return false;
    // MLST unsupported: probe as a file (SIZE) then as a dir (CWD).
    const size = await this.client.command(`SIZE ${path}`);
    if (size.code === 213) return true;
    const cwd = await this.client.command(`CWD ${path}`);
    return cwd.code === 250;
  }

  private async _rename(from: string, to: string): Promise<void> {
    await this.client.commandExpect(`RNFR ${from}`, [350], `RNFR ${from}`);
    await this.client.commandExpect(`RNTO ${to}`, [250], `RNTO ${to}`);
  }

  private async _remove(path: string, recursive: boolean): Promise<void> {
    const st = await this._stat(path);
    if (st.kind === 'dir') {
      const children = await this._list(path);
      if (children.length > 0 && !recursive) {
        throw new FsError('not-empty', `Directory not empty: ${path}`);
      }
      for (const child of children) {
        await this._remove(child.path, true);
      }
      await this.client.commandExpect(`RMD ${path}`, [250], `RMD ${path}`);
    } else {
      await this.client.commandExpect(`DELE ${path}`, [250], `DELE ${path}`);
    }
  }

  // ---- transfers (hold the lock across the handle's lifetime) ----

  async openRead(path: string, offset = 0): Promise<ReadHandle> {
    const release = await this.client.acquire();
    try {
      let size: number | undefined;
      const sizeReply = await this.client.command(`SIZE ${path}`);
      if (sizeReply.code === 213) size = parseSize(sizeReply.text);

      const data = await this.client.openPassive();
      if (offset > 0) {
        await this.client.commandExpect(`REST ${offset}`, [350], 'REST');
      }
      const retr = await this.client.command(`RETR ${path}`);
      if (!transferStarted(retr)) {
        await data.close().catch(() => undefined);
        throw ftpError(retr, `RETR ${path}`);
      }

      const client = this.client;
      let finished = false;
      return {
        size,
        read: (into: Uint8Array) => data.read(into),
        async close(): Promise<void> {
          if (finished) return;
          finished = true;
          try {
            await data.close().catch(() => undefined);
            // Drain the transfer-complete reply (226) so the control channel
            // stays in sync. Tolerate 426/anything on an aborted read.
            await client.readReply().catch(() => undefined);
          } finally {
            release();
          }
        },
      };
    } catch (e) {
      release();
      throw asFsError(e);
    }
  }

  async openWrite(
    path: string,
    _size?: number,
    opts?: { resume?: boolean; pipelineDepth?: number },
  ): Promise<WriteHandle> {
    const release = await this.client.acquire();
    try {
      let startOffset = 0;
      if (opts?.resume) {
        const sizeReply = await this.client.command(`SIZE ${path}`);
        if (sizeReply.code === 213) startOffset = parseSize(sizeReply.text) ?? 0;
      }

      const data = await this.client.openPassive();
      if (startOffset > 0) {
        await this.client.commandExpect(`REST ${startOffset}`, [350], 'REST');
      }
      const stor = await this.client.command(`STOR ${path}`);
      if (!transferStarted(stor)) {
        await data.close().catch(() => undefined);
        throw ftpError(stor, `STOR ${path}`);
      }

      const client = this.client;
      let finished = false;
      return {
        startOffset,
        write: (chunk: Uint8Array) => data.write(chunk),
        async close(): Promise<void> {
          if (finished) return;
          finished = true;
          try {
            await data.close().catch(() => undefined);
            const done = await client.readReply();
            if (done.code !== 226 && done.code !== 250) throw ftpError(done, `STOR ${path}`);
          } finally {
            release();
          }
        },
        async abort(): Promise<void> {
          if (finished) return;
          finished = true;
          try {
            await data.close().catch(() => undefined);
            // Best-effort: read whatever completion reply the server sends
            // (often 426/226). The partial file remains on the server.
            await client.readReply().catch(() => undefined);
          } catch {
            // never throw from abort()
          } finally {
            release();
          }
        },
      };
    } catch (e) {
      release();
      throw asFsError(e);
    }
  }
}
