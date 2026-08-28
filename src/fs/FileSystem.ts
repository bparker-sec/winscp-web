export type FsKind = 'onedrive' | 'sftp' | 's3' | 'webdav' | 'ftp' | 'mock';

export type FsErrorCode =
  | 'not-found'
  | 'exists'
  | 'not-a-file'
  | 'not-a-directory'
  | 'not-empty'
  | 'permission'
  | 'unsupported'
  | 'io';

/**
 * Uniform error thrown by every FileSystem implementation so the UI and the
 * transfer engine can branch on `code` instead of parsing messages.
 */
export class FsError extends Error {
  constructor(
    readonly code: FsErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'FsError';
  }
}

export interface FsEntry {
  name: string;
  path: string; // POSIX-style absolute path within this filesystem
  kind: 'file' | 'dir' | 'symlink';
  size?: number;
  mtime?: number; // epoch ms
  mode?: number; // POSIX permission bits when known
  owner?: string;
  group?: string;
  raw?: unknown;
}

export interface ReadHandle {
  read(into: Uint8Array): Promise<number>; // bytes read; 0 at EOF
  close(): Promise<void>;
  size?: number;
}

export interface WriteHandle {
  write(chunk: Uint8Array): Promise<void>;
  /** Commit the file. */
  close(): Promise<void>;
  /**
   * Abandon the write and roll back any backend resources (e.g. a resumable
   * upload session). Called instead of close() when a transfer is cancelled or
   * fails. Must never throw.
   */
  abort(): Promise<void>;
  /**
   * The byte offset this write resumes from: 0 for a fresh write, or the
   * number of bytes already present at the destination when `openWrite` was
   * called with `{ resume: true }` and a prior partial write was found.
   * Callers should read the source starting at this offset and stream only
   * the remaining bytes into `write()`.
   */
  readonly startOffset: number;
}

/**
 * A protocol-agnostic file system, implemented by the OneDrive and SFTP adapters
 * (and later S3/WebDAV/FTP), plus MockFS for tests.
 *
 * Error contract: on failure, methods throw an {@link FsError} whose `code`
 * classifies the failure.
 *
 * Cancellation: there is no per-call AbortSignal. A transfer is torn down
 * cooperatively — the caller stops pulling from the ReadHandle and calls
 * `ReadHandle.close()` / `WriteHandle.abort()`. This keeps adapter signatures
 * simple while still allowing in-flight transfers to be aborted.
 */
export interface FileSystem {
  readonly kind: FsKind;
  readonly label: string; // shown in the pane header, e.g. "OneDrive" or "deploy@host"
  /** List the direct children of a directory. Throws FsError('not-found'). */
  list(path: string): Promise<FsEntry[]>;
  /** Metadata for one entry. Throws FsError('not-found'). */
  stat(path: string): Promise<FsEntry>;
  /** Create a directory. Throws FsError('exists') if it already exists. */
  mkdir(path: string): Promise<void>;
  /**
   * Rename/move within this filesystem. Overwrite behavior at `to` is
   * adapter-defined; callers should detect conflicts before calling.
   */
  rename(from: string, to: string): Promise<void>;
  /**
   * Remove a file, or a directory. With recursive=false a non-empty directory
   * throws FsError('not-empty').
   */
  remove(path: string, recursive: boolean): Promise<void>;
  /** Move within this filesystem (may be rename or copy+delete). */
  move(from: string, to: string): Promise<void>;
  /**
   * Open a file for streaming reads, starting at `offset` bytes into the
   * file (default 0). Throws FsError('not-a-file') on a dir.
   */
  openRead(path: string, offset?: number): Promise<ReadHandle>;
  /**
   * Open a file for streaming writes. `size` is an optional total-length hint
   * some backends need to initiate a resumable upload; streaming backends may
   * ignore it.
   *
   * `opts.resume`: when true, continue an interrupted write against an
   * existing partial destination instead of truncating it. The returned
   * handle's `startOffset` reports how many bytes were already present (0 if
   * there was nothing to resume, or resume was not requested); callers read
   * the source from `startOffset` and stream only the remaining bytes.
   */
  openWrite(path: string, size?: number, opts?: { resume?: boolean }): Promise<WriteHandle>;
  /** Set POSIX permission bits, where supported (SFTP). */
  chmod?(path: string, mode: number): Promise<void>;
}

/** Folders first, then files, each case-insensitively alphabetical. */
export function sortEntries(entries: FsEntry[]): FsEntry[] {
  return [...entries].sort((a, b) => {
    const af = a.kind === 'dir' ? 0 : 1;
    const bf = b.kind === 'dir' ? 0 : 1;
    if (af !== bf) return af - bf;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

/** Join a POSIX dir + name into a normalized absolute path. */
export function joinPath(dir: string, name: string): string {
  if (dir === '/' || dir === '') return `/${name}`;
  return `${dir.replace(/\/+$/, '')}/${name}`;
}

/** Parent of a POSIX path ("/a/b" -> "/a", "/a" -> "/"). */
export function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i <= 0 ? '/' : trimmed.slice(0, i);
}
