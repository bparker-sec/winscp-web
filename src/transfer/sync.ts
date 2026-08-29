// Directory synchronize / mirror over the FileSystem seam. Compares a source
// tree against a destination tree and produces (then optionally executes) a plan
// of copies, directory creations, and — in mirror mode — deletions of extraneous
// destination entries. Works between ANY two FileSystem adapters (OneDrive⇄SFTP,
// and later FTP/S3/WebDAV) since it only uses list/stat/mkdir/remove + the engine.

import { FsError, joinPath, type FileSystem, type FsEntry } from '../fs/FileSystem';
import { transferFile, TransferCancelled, type TransferProgress } from './engine';

/** 'update' copies new/changed only; 'mirror' also deletes extraneous dst entries. */
export type SyncMode = 'update' | 'mirror';
/** How a file is judged unchanged: by size only, or size + newer source mtime. */
export type CompareBy = 'size-mtime' | 'size';

export interface SyncOptions {
  mode?: SyncMode; // default 'update'
  compareBy?: CompareBy; // default 'size-mtime'
  /** Clock-skew tolerance (ms) before a newer source mtime forces a re-copy. */
  mtimeToleranceMs?: number; // default 2000
  signal?: AbortSignal;
  pipelineDepth?: number;
  /** Progress across the whole run: cumulative bytes over the plan's total. */
  onProgress?: (p: TransferProgress & { file?: string }) => void;
}

export type SyncAction =
  | { kind: 'copy'; srcPath: string; dstPath: string; name: string; size?: number; reason: 'new' | 'changed' }
  | { kind: 'mkdir'; dstPath: string; name: string }
  | { kind: 'delete'; dstPath: string; name: string; isDir: boolean };

export interface SyncResult {
  copied: number;
  created: number;
  deleted: number;
  bytes: number;
  actions: SyncAction[];
}

/**
 * Decide whether a source file must be (re)copied over the destination entry.
 * Returns 'new' (missing), 'changed' (differs), or null (up to date).
 */
export function fileNeedsCopy(
  src: FsEntry,
  dst: FsEntry | undefined,
  compareBy: CompareBy,
  toleranceMs: number,
): 'new' | 'changed' | null {
  if (!dst) return 'new';
  if (dst.kind !== 'file') return 'changed'; // a directory sits where a file should
  if (src.size !== undefined && dst.size !== undefined && src.size !== dst.size) return 'changed';
  if (compareBy === 'size-mtime' && src.mtime !== undefined && dst.mtime !== undefined) {
    if (src.mtime > dst.mtime + toleranceMs) return 'changed';
  }
  return null;
}

async function listOrEmpty(fs: FileSystem, path: string): Promise<FsEntry[]> {
  try {
    return await fs.list(path);
  } catch (e) {
    if (e instanceof FsError && e.code === 'not-found') return [];
    throw e;
  }
}

/**
 * Compute the ordered list of actions to make `dstRoot` match `srcRoot`
 * (mkdir/copy top-down so parents exist before their children; deletes come
 * after copies at each level). Does not modify anything.
 */
export async function computeSyncPlan(
  src: FileSystem,
  srcRoot: string,
  dst: FileSystem,
  dstRoot: string,
  opts: SyncOptions = {},
): Promise<SyncAction[]> {
  const mode = opts.mode ?? 'update';
  const compareBy = opts.compareBy ?? 'size-mtime';
  const tol = opts.mtimeToleranceMs ?? 2000;
  const actions: SyncAction[] = [];

  async function walk(sPath: string, dPath: string): Promise<void> {
    const srcEntries = await src.list(sPath);
    const dstEntries = await listOrEmpty(dst, dPath);
    const dstByName = new Map(dstEntries.map((e) => [e.name, e]));

    for (const s of srcEntries) {
      if (s.kind === 'symlink') continue; // don't follow/copy symlinks
      const dEntry = dstByName.get(s.name);
      const dChild = joinPath(dPath, s.name);
      if (s.kind === 'dir') {
        if (!dEntry || dEntry.kind !== 'dir') actions.push({ kind: 'mkdir', dstPath: dChild, name: s.name });
        await walk(s.path, dChild);
      } else {
        const reason = fileNeedsCopy(s, dEntry, compareBy, tol);
        if (reason) actions.push({ kind: 'copy', srcPath: s.path, dstPath: dChild, name: s.name, size: s.size, reason });
      }
    }

    if (mode === 'mirror') {
      const srcNames = new Set(srcEntries.map((e) => e.name));
      for (const d of dstEntries) {
        if (!srcNames.has(d.name)) {
          actions.push({ kind: 'delete', dstPath: d.path, name: d.name, isDir: d.kind === 'dir' });
        }
      }
    }
  }

  await walk(srcRoot, dstRoot);
  return actions;
}

/** Sum the byte size of a plan's copy actions (unknown sizes count as 0). */
export function planTotalBytes(actions: SyncAction[]): number {
  return actions.reduce((n, a) => n + (a.kind === 'copy' ? (a.size ?? 0) : 0), 0);
}

/**
 * Execute a synchronize: ensure `dstRoot` exists, compute the plan, then apply
 * it (mkdir → copy → delete) with cumulative progress. Aborts cooperatively via
 * `opts.signal`.
 */
export async function synchronize(
  src: FileSystem,
  srcRoot: string,
  dst: FileSystem,
  dstRoot: string,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const throwIfAborted = () => {
    if (opts.signal?.aborted) throw new TransferCancelled();
  };

  // Make sure the destination root directory exists before diffing into it.
  try {
    await dst.mkdir(dstRoot);
  } catch (e) {
    if (!(e instanceof FsError && e.code === 'exists')) throw e;
  }

  const actions = await computeSyncPlan(src, srcRoot, dst, dstRoot, opts);
  const totalBytes = planTotalBytes(actions);
  let bytes = 0;
  const result: SyncResult = { copied: 0, created: 0, deleted: 0, bytes: 0, actions };

  for (const a of actions) {
    throwIfAborted();
    if (a.kind === 'mkdir') {
      try {
        await dst.mkdir(a.dstPath);
      } catch (e) {
        if (!(e instanceof FsError && e.code === 'exists')) throw e;
      }
      result.created++;
    } else if (a.kind === 'copy') {
      const base = bytes;
      await transferFile(src, a.srcPath, dst, a.dstPath, a.size, {
        signal: opts.signal,
        pipelineDepth: opts.pipelineDepth,
        onProgress: (p) => opts.onProgress?.({ bytes: base + p.bytes, total: totalBytes, file: a.name }),
      });
      bytes = base + (a.size ?? 0);
      result.bytes = bytes;
      result.copied++;
    } else {
      await dst.remove(a.dstPath, true);
      result.deleted++;
    }
  }

  return result;
}
