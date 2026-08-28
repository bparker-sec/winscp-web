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
}

const DEFAULT_CHUNK = 256 * 1024;

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
  const r = await src.openRead(srcPath);
  let w;
  try {
    w = await dst.openWrite(dstPath, size);
  } catch (e) {
    await r.close().catch(() => {});
    throw e;
  }

  const buf = new Uint8Array(opts.chunkSize ?? DEFAULT_CHUNK);
  let bytes = 0;
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
