import { FsError, joinPath, parentPath, type FileSystem } from '../fs/FileSystem';
import { transferFile, transferTree, TransferCancelled } from './engine';
import { describeError } from '../fs/describeError';

export type JobState = 'queued' | 'active' | 'conflict' | 'done' | 'skipped' | 'error' | 'cancelled';
export type Direction = 'up' | 'down';

export interface TransferJob {
  id: string;
  name: string;
  direction: Direction;
  src: FileSystem;
  srcPath: string;
  dst: FileSystem;
  dstPath: string;
  size?: number;
  isDir: boolean;
  state: JobState;
  bytes: number;
  error?: string;
  /**
   * Set once the job's first run has started. A subsequent run (via retry)
   * resumes the transfer from the destination's current position instead of
   * starting over; the very first attempt is always fresh.
   */
  attempted?: boolean;
  /** True once this job has been retried at least once. UI hint only. */
  retried?: boolean;
  /**
   * Skip the exists/conflict check and overwrite the destination unconditionally.
   * Used by synchronize, where an already-decided plan should not re-prompt.
   */
  overwrite?: boolean;
  /** Epoch ms when the current run's byte transfer began (reset on each retry). */
  startedAt?: number;
  /** Epoch ms when the job reached a terminal state after actually transferring. */
  finishedAt?: number;
  /**
   * job.bytes at the moment `startedAt` was set — the resume offset for this run
   * (0 for a fresh transfer). Throughput/elapsed are measured from here so a
   * resumed transfer's rate reflects only the bytes moved this run.
   */
  startBytes?: number;
  /**
   * True for a job restored from a previous session's persisted history. Its
   * live FileSystem handles are gone, so it is display-only: it can't be run or
   * retried, only cleared.
   */
  restored?: boolean;
}

/** The serializable subset of a job persisted across reloads (no live handles). */
export interface PersistedJob {
  id: string;
  name: string;
  direction: Direction;
  srcPath: string;
  dstPath: string;
  size?: number;
  isDir: boolean;
  state: JobState;
  bytes: number;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

function toPersisted(job: TransferJob): PersistedJob {
  return {
    id: job.id,
    name: job.name,
    direction: job.direction,
    srcPath: job.srcPath,
    dstPath: job.dstPath,
    size: job.size,
    isDir: job.isDir,
    state: job.state,
    bytes: job.bytes,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

// Stand-in FileSystem for restored (display-only) jobs; it must never run.
const DEAD_FS = { kind: 'mock', label: '(previous session)' } as unknown as FileSystem;

export type ConflictChoice = 'overwrite' | 'skip' | 'rename';
export type ConflictResolver = (job: TransferJob) => Promise<ConflictChoice>;

export interface EnqueueEntry {
  name: string;
  direction: Direction;
  src: FileSystem;
  srcPath: string;
  dst: FileSystem;
  dstPath: string;
  size?: number;
  isDir: boolean;
  /** Overwrite the destination without a conflict prompt (used by synchronize). */
  overwrite?: boolean;
}

const TERMINAL_STATES: JobState[] = ['done', 'skipped', 'error', 'cancelled'];
const PROGRESS_THROTTLE_MS = 100;

/**
 * Find a free name in `dir` on `dst`, starting from `name`. Probes
 * `base (1).ext`, `base (2).ext`, ... until `stat` throws 'not-found'.
 */
export async function uniqueName(dst: FileSystem, dir: string, name: string): Promise<string> {
  const dotIdx = name.lastIndexOf('.');
  // Not a "dotfile" extension split when the dot is at position 0 (e.g. ".env") or missing.
  const base = dotIdx > 0 ? name.slice(0, dotIdx) : name;
  const ext = dotIdx > 0 ? name.slice(dotIdx) : '';

  const isFree = async (candidate: string): Promise<boolean> => {
    try {
      await dst.stat(joinPath(dir, candidate));
      return false;
    } catch (e) {
      if (e instanceof FsError && e.code === 'not-found') return true;
      throw e;
    }
  };

  if (await isFree(name)) return name;

  const MAX_ATTEMPTS = 1000;
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (await isFree(candidate)) return candidate;
  }
  throw new Error(`Could not find a unique name for ${name}`);
}

export class TransferQueue {
  private readonly concurrency: number;
  private readonly conflict: ConflictResolver;
  private readonly pipelineDepth?: () => number;
  private readonly onPersist?: (jobs: PersistedJob[]) => void;
  private jobsList: TransferJob[] = [];
  private activeCount = 0;
  private readonly controllers = new Map<string, AbortController>();
  private readonly listeners = new Set<(jobs: TransferJob[]) => void>();
  private lastProgressEmit = 0;

  constructor(opts?: {
    concurrency?: number;
    conflict?: ConflictResolver;
    /** Read at each transfer's start so a settings change applies to new transfers. */
    pipelineDepth?: () => number;
    /** Called with the persistable job list whenever it changes (for reload survival). */
    onPersist?: (jobs: PersistedJob[]) => void;
    /** History from a previous session, hydrated as display-only "restored" jobs. */
    restoredJobs?: PersistedJob[];
  }) {
    this.concurrency = opts?.concurrency ?? 2;
    this.conflict = opts?.conflict ?? (async () => 'overwrite');
    this.pipelineDepth = opts?.pipelineDepth;
    this.onPersist = opts?.onPersist;
    if (opts?.restoredJobs?.length) {
      this.jobsList = opts.restoredJobs.map((p) => {
        // A job left non-terminal by a reload can't continue (its live handles
        // are gone) — show it as interrupted rather than pretending it's running.
        const wasInterrupted = !TERMINAL_STATES.includes(p.state);
        return {
          ...p,
          src: DEAD_FS,
          dst: DEAD_FS,
          restored: true,
          state: wasInterrupted ? 'error' : p.state,
          error: wasInterrupted ? 'Interrupted by page reload' : p.error,
        } satisfies TransferJob;
      });
    }
  }

  enqueue(entry: EnqueueEntry): string {
    const job: TransferJob = {
      id: crypto.randomUUID(),
      name: entry.name,
      direction: entry.direction,
      src: entry.src,
      srcPath: entry.srcPath,
      dst: entry.dst,
      dstPath: entry.dstPath,
      size: entry.size,
      isDir: entry.isDir,
      overwrite: entry.overwrite,
      state: 'queued',
      bytes: 0,
    };
    this.jobsList.push(job);
    this.emit(true);
    this.pump();
    return job.id;
  }

  jobs(): TransferJob[] {
    return [...this.jobsList];
  }

  subscribe(fn: (jobs: TransferJob[]) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  cancel(id: string): void {
    const job = this.jobsList.find((j) => j.id === id);
    if (!job) return;
    if (job.state === 'queued') {
      job.state = 'cancelled';
      this.emit(true);
      return;
    }
    if (job.state === 'active' || job.state === 'conflict') {
      this.controllers.get(id)?.abort();
    }
  }

  cancelAll(): void {
    for (const job of this.jobsList) {
      if (!TERMINAL_STATES.includes(job.state)) this.cancel(job.id);
    }
  }

  retry(id: string): void {
    const job = this.jobsList.find((j) => j.id === id);
    if (!job) return;
    // Restored (previous-session) jobs have no live handles and can't be re-run.
    if (job.restored) return;
    if (job.state !== 'error' && job.state !== 'cancelled') return;
    job.state = 'queued';
    job.retried = true;
    // Leave job.bytes as-is (not reset to 0): a resumed transfer's first
    // onProgress reports the resumed offset, so resetting here would just
    // cause a visual flash to 0% before jumping back up.
    job.error = undefined;
    this.emit(true);
    this.pump();
  }

  clearFinished(): void {
    this.jobsList = this.jobsList.filter((j) => !TERMINAL_STATES.includes(j.state));
    this.emit(true);
  }

  private pump(): void {
    while (this.activeCount < this.concurrency) {
      const job = this.jobsList.find((j) => j.state === 'queued');
      if (!job) break;
      this.activeCount++;
      void this.run(job);
    }
  }

  private async run(job: TransferJob): Promise<void> {
    job.state = 'active';
    this.emit(true);

    // Only file jobs can resume (a directory tree has no single byte offset
    // to continue from - it just re-runs transferTree from the top, which is
    // cheap since existing files/dirs are left alone / re-verified). The
    // first attempt of any job is always fresh; only a retry resumes.
    const resume = !job.isDir && job.attempted === true;
    job.attempted = true;

    const controller = new AbortController();
    this.controllers.set(job.id, controller);

    try {
      let target = job.dstPath;

      if (!job.isDir && !resume && !job.overwrite) {
        let exists = true;
        try {
          await job.dst.stat(target);
        } catch (e) {
          if (e instanceof FsError && e.code === 'not-found') {
            exists = false;
          } else {
            throw e;
          }
        }

        if (exists) {
          job.state = 'conflict';
          this.emit(true);
          // Race the conflict resolution against cancellation: cancel() during
          // 'conflict' only aborts the signal — nothing else was listening to it
          // while we sat here awaiting the resolver, so a cancel would otherwise
          // never unblock this job (it would hang in 'conflict' forever).
          const choice = await Promise.race<ConflictChoice | 'cancel'>([
            this.conflict(job),
            new Promise<'cancel'>((resolve) => {
              if (controller.signal.aborted) {
                resolve('cancel');
                return;
              }
              controller.signal.addEventListener('abort', () => resolve('cancel'), { once: true });
            }),
          ]);
          if (choice === 'cancel' || controller.signal.aborted) throw new TransferCancelled();
          if (choice === 'skip') {
            job.state = 'skipped';
            this.emit(true);
            return;
          }
          if (choice === 'rename') {
            const dir = parentPath(job.dstPath);
            target = joinPath(dir, await uniqueName(job.dst, dir, job.name));
          }
          job.state = 'active';
          this.emit(true);
        }
      }

      const pipelineDepth = this.pipelineDepth?.();

      // Mark the start of the actual byte transfer for throughput/elapsed. Reset
      // each run so a retry/resume measures only this run's bytes.
      job.startedAt = Date.now();
      job.startBytes = job.bytes;
      job.finishedAt = undefined;

      if (job.isDir) {
        await transferTree(job.src, job.srcPath, job.dst, target, {
          signal: controller.signal,
          pipelineDepth,
          onProgress: (p) => {
            job.bytes = p.bytes;
            this.emit(false);
          },
        });
      } else {
        await transferFile(job.src, job.srcPath, job.dst, target, job.size, {
          signal: controller.signal,
          resume,
          pipelineDepth,
          onProgress: (p) => {
            job.bytes = p.bytes;
            this.emit(false);
          },
        });
      }

      job.state = 'done';
      job.bytes = job.size ?? job.bytes;
      job.finishedAt = Date.now();
      this.emit(true);
    } catch (err) {
      job.finishedAt = Date.now();
      if (err instanceof TransferCancelled) {
        job.state = 'cancelled';
      } else {
        job.state = 'error';
        job.error = describeError(err);
      }
      this.emit(true);
    } finally {
      this.activeCount--;
      this.controllers.delete(job.id);
      this.pump();
    }
  }

  private emit(immediate: boolean): void {
    const now = Date.now();
    if (!immediate && now - this.lastProgressEmit < PROGRESS_THROTTLE_MS) return;
    this.lastProgressEmit = now;
    const snapshot = this.jobs();
    for (const fn of this.listeners) {
      try {
        fn(snapshot);
      } catch {
        // A misbehaving subscriber must not break the queue or other listeners.
      }
    }
    // Persist on the immediate (state-change) emits only — not every throttled
    // progress tick — so reload survives without hammering storage.
    if (immediate && this.onPersist) {
      try {
        this.onPersist(snapshot.map(toPersisted));
      } catch {
        // storage may be unavailable (private mode, quota) — never break the queue
      }
    }
  }
}
