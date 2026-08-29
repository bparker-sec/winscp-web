import { FsError, joinPath, type FileSystem } from '../fs/FileSystem';

/** Thrown when a transfer is stopped via an AbortSignal. */
export class TransferCancelled extends Error {
  constructor() {
    super('Transfer cancelled');
    this.name = 'TransferCancelled';
  }
}

export interface TransferProgress {
  bytes: number;
  total?: number;
}

export interface TransferOptions {
  signal?: AbortSignal;
  onProgress?: (p: TransferProgress) => void;
  chunkSize?: number;
  /**
   * Continue an interrupted write against an existing partial destination
   * instead of truncating it. The source is read starting at the
   * destination's `startOffset` (0 if there was nothing to resume, or the
   * backend doesn't support it).
   */
  resume?: boolean;
  /**
   * How many read/write requests a pipelining backend (SFTP) may keep in flight
   * at once. Non-pipelining backends ignore it. Undefined = backend default
   * (serial).
   */
  pipelineDepth?: number;
}

// 255 KiB, not 256: it matches the SFTP layer's per-message payload cap
// (MAX_SFTP_PAYLOAD), so an SFTP upload sends exactly one WRITE per chunk. A
// 256 KiB chunk would overflow the SFTP message limit and be split into a
// 255 KiB + 1 KiB pair, and because transfers aren't pipelined that tiny second
// write costs a full round-trip — roughly halving WAN throughput. Backends that
// re-buffer (e.g. OneDrive's 320 KiB-aligned upload) are unaffected by the exact
// value.
const DEFAULT_CHUNK = 255 * 1024;

/**
 * Stream one file from `src`/`srcPath` to `dst`/`dstPath`, chunk by chunk.
 * Never buffers the whole file in memory. On cancellation or any error the
 * destination write is aborted (rolled back) and the original error/
 * TransferCancelled is rethrown.
 */
export async function transferFile(
  src: FileSystem,
  srcPath: string,
  dst: FileSystem,
  dstPath: string,
  size: number | undefined,
  opts: TransferOptions = {},
): Promise<void> {
  // Note: openWrite is called before openRead here (opposite of the pre-resume
  // ordering) so we know startOffset before deciding whether a reader is even
  // needed — a fully-resumed destination skips opening the source entirely.
  const w = await dst.openWrite(dstPath, size, {
    resume: opts.resume,
    pipelineDepth: opts.pipelineDepth,
  });
  const start = w.startOffset;

  if (size !== undefined && start >= size) {
    // Already complete (or a stale partial that's >= the source size, which
    // we treat as complete rather than risk corrupting it further).
    await w.close();
    opts.onProgress?.({ bytes: size, total: size });
    return;
  }

  let r;
  try {
    r = await src.openRead(srcPath, start, { pipelineDepth: opts.pipelineDepth });
  } catch (e) {
    await w.abort().catch(() => {});
    throw e;
  }

  const buf = new Uint8Array(opts.chunkSize ?? DEFAULT_CHUNK);
  let bytes = start;
  opts.onProgress?.({ bytes, total: size });
  try {
    for (;;) {
      if (opts.signal?.aborted) throw new TransferCancelled();
      const n = await r.read(buf);
      if (n === 0) break;
      await w.write(buf.subarray(0, n));
      bytes += n;
      opts.onProgress?.({ bytes, total: size });
    }
  } catch (err) {
    await w.abort().catch(() => {});
    await r.close().catch(() => {});
    throw err;
  }

  await w.close();
  await r.close();
}

/**
 * Stream a whole file/directory tree from `src`/`srcPath` to `dst`/`dstPath`.
 * Directories are created (existing ones are left alone); files are streamed
 * via {@link transferFile}. `onFile` is called with each source file path
 * just before it starts transferring, for progress aggregation.
 */
export async function transferTree(
  src: FileSystem,
  srcPath: string,
  dst: FileSystem,
  dstPath: string,
  opts: TransferOptions = {},
  onFile?: (path: string) => void,
): Promise<void> {
  if (opts.signal?.aborted) throw new TransferCancelled();

  const st = await src.stat(srcPath);
  if (st.kind === 'dir') {
    try {
      await dst.mkdir(dstPath);
    } catch (e) {
      if (!(e instanceof FsError && e.code === 'exists')) throw e;
    }
    for (const child of await src.list(srcPath)) {
      await transferTree(src, child.path, dst, joinPath(dstPath, child.name), opts, onFile);
    }
  } else {
    onFile?.(srcPath);
    await transferFile(src, srcPath, dst, dstPath, st.size, opts);
  }
}
