export type FsKind = 'onedrive' | 'sftp' | 'mock';

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
  close(): Promise<void>;
}

export interface FileSystem {
  readonly kind: FsKind;
  readonly label: string; // shown in the pane header, e.g. "OneDrive" or "deploy@host"
  list(path: string): Promise<FsEntry[]>;
  stat(path: string): Promise<FsEntry>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string, recursive: boolean): Promise<void>;
  move(from: string, to: string): Promise<void>;
  openRead(path: string): Promise<ReadHandle>;
  openWrite(path: string, size?: number): Promise<WriteHandle>;
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

/** Parent of a POSIX path ("/a/b" → "/a", "/a" → "/"). */
export function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i <= 0 ? '/' : trimmed.slice(0, i);
}
