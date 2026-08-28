import { describe, it, expect, vi } from 'vitest';
import type { FileSystem, ReadHandle } from '../fs/FileSystem';
import { MockFS } from '../fs/MockFS';
import { TransferQueue, uniqueName, type TransferJob, type ConflictChoice } from './queue';

async function writeFile(fs: FileSystem, path: string, text: string): Promise<void> {
  const data = new TextEncoder().encode(text);
  const w = await fs.openWrite(path, data.byteLength);
  await w.write(data);
  await w.close();
}

async function readText(fs: FileSystem, path: string): Promise<string> {
  const r = await fs.openRead(path);
  const chunks: Uint8Array[] = [];
  const buf = new Uint8Array(4096);
  for (;;) {
    const n = await r.read(buf);
    if (n === 0) break;
    chunks.push(buf.slice(0, n));
  }
  await r.close();
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return new TextDecoder().decode(out);
}

/**
 * Delegates every FileSystem method to `fs`, with `overrides` replacing specific
 * ones. Needed because spreading a class instance (`{ ...fs }`) only copies its
 * own enumerable fields, not prototype methods.
 */
function wrapFs(fs: FileSystem, overrides: Partial<FileSystem>): FileSystem {
  return {
    kind: fs.kind,
    label: fs.label,
    list: (p) => fs.list(p),
    stat: (p) => fs.stat(p),
    mkdir: (p) => fs.mkdir(p),
    rename: (a, b) => fs.rename(a, b),
    remove: (p, r) => fs.remove(p, r),
    move: (a, b) => fs.move(a, b),
    openRead: (p) => fs.openRead(p),
    openWrite: (p, s) => fs.openWrite(p, s),
    ...overrides,
  };
}

/** Wraps a FileSystem so every read pauses briefly, letting concurrency be observed. */
function withSlowReads(fs: FileSystem, delayMs = 30): FileSystem {
  return wrapFs(fs, {
    openRead: async (path: string): Promise<ReadHandle> => {
      const inner = await fs.openRead(path);
      return {
        size: inner.size,
        read: async (into: Uint8Array) => {
          await new Promise((r) => setTimeout(r, delayMs));
          return inner.read(into);
        },
        close: () => inner.close(),
      };
    },
  });
}

function waitForState(
  queue: TransferQueue,
  id: string,
  states: string[],
): Promise<TransferJob> {
  return new Promise((resolve) => {
    const unsub = queue.subscribe((jobs) => {
      const job = jobs.find((j) => j.id === id);
      if (job && states.includes(job.state)) {
        unsub();
        resolve(job);
      }
    });
    // Also check current state immediately in case it's already there.
    const job = queue.jobs().find((j) => j.id === id);
    if (job && states.includes(job.state)) {
      unsub();
      resolve(job);
    }
  });
}

const TERMINAL = ['done', 'skipped', 'error', 'cancelled'];

describe('TransferQueue', () => {
  it('runs an enqueued file job to completion', async () => {
    const src = new MockFS('src');
    const dst = new MockFS('dst');
    await writeFile(src, '/a.txt', 'hello queue');

    const queue = new TransferQueue();
    const id = queue.enqueue({
      name: 'a.txt',
      direction: 'up',
      src,
      srcPath: '/a.txt',
      dst,
      dstPath: '/a.txt',
      size: 11,
      isDir: false,
    });

    const job = await waitForState(queue, id, TERMINAL);
    expect(job.state).toBe('done');
    expect(job.bytes).toBe(11);
    await expect(readText(dst, '/a.txt')).resolves.toBe('hello queue');
  });

  it('respects the concurrency cap', async () => {
    const rawSrc = new MockFS('src');
    for (const n of ['x', 'y', 'z']) {
      await writeFile(rawSrc, `/${n}.txt`, `data-${n}`);
    }
    const src = withSlowReads(rawSrc);
    const dst = new MockFS('dst');

    const queue = new TransferQueue({ concurrency: 2 });
    let maxActive = 0;
    queue.subscribe((jobs) => {
      const active = jobs.filter((j) => j.state === 'active').length;
      maxActive = Math.max(maxActive, active);
    });

    const ids = ['x', 'y', 'z'].map((n) =>
      queue.enqueue({
        name: `${n}.txt`,
        direction: 'up',
        src,
        srcPath: `/${n}.txt`,
        dst,
        dstPath: `/${n}.txt`,
        size: 6,
        isDir: false,
      }),
    );

    await Promise.all(ids.map((id) => waitForState(queue, id, TERMINAL)));
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBeGreaterThan(0);
  });

  it('skips on conflict when the resolver chooses skip', async () => {
    const src = new MockFS('src');
    const dst = new MockFS('dst');
    await writeFile(src, '/a.txt', 'new contents');
    await writeFile(dst, '/a.txt', 'old contents');

    const queue = new TransferQueue({ conflict: async () => 'skip' as ConflictChoice });
    const id = queue.enqueue({
      name: 'a.txt',
      direction: 'up',
      src,
      srcPath: '/a.txt',
      dst,
      dstPath: '/a.txt',
      size: 12,
      isDir: false,
    });

    const job = await waitForState(queue, id, TERMINAL);
    expect(job.state).toBe('skipped');
    await expect(readText(dst, '/a.txt')).resolves.toBe('old contents');
  });

  it('renames on conflict when the resolver chooses rename', async () => {
    const src = new MockFS('src');
    const dst = new MockFS('dst');
    await writeFile(src, '/a.txt', 'new contents');
    await writeFile(dst, '/a.txt', 'old contents');

    const queue = new TransferQueue({ conflict: async () => 'rename' as ConflictChoice });
    const id = queue.enqueue({
      name: 'a.txt',
      direction: 'up',
      src,
      srcPath: '/a.txt',
      dst,
      dstPath: '/a.txt',
      size: 12,
      isDir: false,
    });

    const job = await waitForState(queue, id, TERMINAL);
    expect(job.state).toBe('done');
    await expect(readText(dst, '/a.txt')).resolves.toBe('old contents');
    await expect(readText(dst, '/a (1).txt')).resolves.toBe('new contents');
    const listing = await dst.list('/');
    expect(listing.some((e) => e.name === 'a (1).txt')).toBe(true);
  });

  it('overwrites on conflict when the resolver chooses overwrite', async () => {
    const src = new MockFS('src');
    const dst = new MockFS('dst');
    await writeFile(src, '/a.txt', 'new contents');
    await writeFile(dst, '/a.txt', 'old contents');

    const queue = new TransferQueue({ conflict: async () => 'overwrite' as ConflictChoice });
    const id = queue.enqueue({
      name: 'a.txt',
      direction: 'up',
      src,
      srcPath: '/a.txt',
      dst,
      dstPath: '/a.txt',
      size: 12,
      isDir: false,
    });

    const job = await waitForState(queue, id, TERMINAL);
    expect(job.state).toBe('done');
    await expect(readText(dst, '/a.txt')).resolves.toBe('new contents');
  });

  it('cancels a queued job before it ever runs', async () => {
    const src = new MockFS('src');
    const dst = new MockFS('dst');
    await writeFile(src, '/blocker.txt', 'blocker');
    await writeFile(src, '/q.txt', 'queued job');

    // concurrency 1, first job never resolves its read until we say so
    let releaseBlocker: () => void = () => {};
    const blockerGate = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const slowSrc: FileSystem = wrapFs(src, {
      openRead: async (path: string) => {
        const inner = await src.openRead(path);
        if (path === '/blocker.txt') {
          return {
            size: inner.size,
            read: async (into: Uint8Array) => {
              await blockerGate;
              return inner.read(into);
            },
            close: () => inner.close(),
          };
        }
        return inner;
      },
    });

    const queue = new TransferQueue({ concurrency: 1 });
    queue.enqueue({
      name: 'blocker.txt',
      direction: 'up',
      src: slowSrc,
      srcPath: '/blocker.txt',
      dst,
      dstPath: '/blocker.txt',
      size: 7,
      isDir: false,
    });
    const queuedId = queue.enqueue({
      name: 'q.txt',
      direction: 'up',
      src: slowSrc,
      srcPath: '/q.txt',
      dst,
      dstPath: '/q.txt',
      size: 10,
      isDir: false,
    });

    // The second job should still be queued (concurrency 1, first job blocked).
    expect(queue.jobs().find((j) => j.id === queuedId)?.state).toBe('queued');
    queue.cancel(queuedId);
    const cancelled = queue.jobs().find((j) => j.id === queuedId);
    expect(cancelled?.state).toBe('cancelled');

    releaseBlocker();
    await vi.waitFor(() => {
      const blocker = queue.jobs().find((j) => j.srcPath === '/blocker.txt');
      expect(blocker?.state).toBe('done');
    });
  });

  it('cancels an active job via abort', async () => {
    const src = new MockFS('src');
    const dst = new MockFS('dst');
    await writeFile(src, '/big.txt', 'x'.repeat(1000));

    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let sawRead = false;
    const slowSrc: FileSystem = wrapFs(src, {
      openRead: async (path: string) => {
        const inner = await src.openRead(path);
        return {
          size: inner.size,
          read: async (into: Uint8Array) => {
            if (!sawRead) {
              sawRead = true;
              releaseGate();
            }
            await new Promise((r) => setTimeout(r, 20));
            return inner.read(into);
          },
          close: () => inner.close(),
        };
      },
    });

    const queue = new TransferQueue();
    const id = queue.enqueue({
      name: 'big.txt',
      direction: 'up',
      src: slowSrc,
      srcPath: '/big.txt',
      dst,
      dstPath: '/big.txt',
      size: 1000,
      isDir: false,
    });

    await gate; // wait until the transfer has started reading
    queue.cancel(id);
    const job = await waitForState(queue, id, TERMINAL);
    expect(job.state).toBe('cancelled');
  });

  it('moves a failed job back to queued on retry', async () => {
    const src = new MockFS('src');
    const dst = new MockFS('dst');
    // Never seed /missing.txt on src, so openRead throws not-found -> job errors.

    const queue = new TransferQueue();
    const id = queue.enqueue({
      name: 'missing.txt',
      direction: 'up',
      src,
      srcPath: '/missing.txt',
      dst,
      dstPath: '/missing.txt',
      size: 5,
      isDir: false,
    });

    const errored = await waitForState(queue, id, TERMINAL);
    expect(errored.state).toBe('error');
    expect(errored.error).toBeTruthy();

    const seenStates: string[] = [];
    queue.subscribe((jobs) => {
      const job = jobs.find((j) => j.id === id);
      if (job) seenStates.push(job.state);
    });

    queue.retry(id);
    await waitForState(queue, id, ['error']); // still missing src -> errors again

    expect(seenStates[0]).toBe('queued');
    expect(seenStates).toContain('error');
  });

  it('notifies subscribers on enqueue and completion', async () => {
    const src = new MockFS('src');
    const dst = new MockFS('dst');
    await writeFile(src, '/s.txt', 'sub test');

    const queue = new TransferQueue();
    const seenStates: string[] = [];
    queue.subscribe((jobs) => {
      const job = jobs[0];
      if (job) seenStates.push(job.state);
    });

    const id = queue.enqueue({
      name: 's.txt',
      direction: 'up',
      src,
      srcPath: '/s.txt',
      dst,
      dstPath: '/s.txt',
      size: 8,
      isDir: false,
    });

    await waitForState(queue, id, TERMINAL);
    expect(seenStates).toContain('queued');
    expect(seenStates).toContain('done');
  });

  it('does not orphan a job when two conflicts happen concurrently (serialized resolver)', async () => {
    const src = new MockFS('src');
    const dst = new MockFS('dst');
    await writeFile(src, '/a.txt', 'new a');
    await writeFile(src, '/b.txt', 'new b');
    await writeFile(dst, '/a.txt', 'old a');
    await writeFile(dst, '/b.txt', 'old b');

    // A resolver that answers every job it's asked about — but only one job at a
    // time reaches it if the queue serializes correctly (concurrency 2 means both
    // jobs hit 'conflict' around the same time in a naive single-slot resolver).
    const seen: string[] = [];
    const queue = new TransferQueue({
      concurrency: 2,
      conflict: async (job) => {
        seen.push(job.name);
        return 'overwrite';
      },
    });

    const idA = queue.enqueue({
      name: 'a.txt',
      direction: 'up',
      src,
      srcPath: '/a.txt',
      dst,
      dstPath: '/a.txt',
      size: 5,
      isDir: false,
    });
    const idB = queue.enqueue({
      name: 'b.txt',
      direction: 'up',
      src,
      srcPath: '/b.txt',
      dst,
      dstPath: '/b.txt',
      size: 5,
      isDir: false,
    });

    const [jobA, jobB] = await Promise.all([
      waitForState(queue, idA, TERMINAL),
      waitForState(queue, idB, TERMINAL),
    ]);

    // Neither job may be orphaned in 'conflict' forever — both must reach a
    // terminal state.
    expect(jobA.state).toBe('done');
    expect(jobB.state).toBe('done');
    expect(seen.sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('cancelling a job while it awaits the conflict resolver frees its slot', async () => {
    const src = new MockFS('src');
    const dst = new MockFS('dst');
    await writeFile(src, '/blocked.txt', 'new contents');
    await writeFile(dst, '/blocked.txt', 'old contents');
    await writeFile(src, '/next.txt', 'next job contents');

    // A resolver that never answers — the only way `blocked.txt` can leave
    // 'conflict' is via queue.cancel().
    const queue = new TransferQueue({ concurrency: 1, conflict: () => new Promise(() => {}) });

    const blockedId = queue.enqueue({
      name: 'blocked.txt',
      direction: 'up',
      src,
      srcPath: '/blocked.txt',
      dst,
      dstPath: '/blocked.txt',
      size: 12,
      isDir: false,
    });
    const nextId = queue.enqueue({
      name: 'next.txt',
      direction: 'up',
      src,
      srcPath: '/next.txt',
      dst,
      dstPath: '/next.txt',
      size: 18,
      isDir: false,
    });

    await waitForState(queue, blockedId, ['conflict']);
    // With concurrency 1 and the first job stuck in 'conflict', the second must
    // still be queued.
    expect(queue.jobs().find((j) => j.id === nextId)?.state).toBe('queued');

    queue.cancel(blockedId);
    const cancelled = await waitForState(queue, blockedId, TERMINAL);
    expect(cancelled.state).toBe('cancelled');

    // The slot must free so the next queued job actually runs.
    const next = await waitForState(queue, nextId, TERMINAL);
    expect(next.state).toBe('done');
  });

  it('resumes a retried job from its partial destination instead of restarting', async () => {
    const full = 'x'.repeat(1000);
    const src = new MockFS('src');
    await writeFile(src, '/big.bin', full);

    const dst = new MockFS('dst');
    // Pre-seed a 500-byte partial destination, as if a previous crash had
    // already gotten that much of the file to the remote side.
    await writeFile(dst, '/big.bin', full.slice(0, 500));

    let failFirstRead = true;
    const flakySrc = wrapFs(src, {
      openRead: async (path: string, offset?: number) => {
        if (failFirstRead) {
          failFirstRead = false;
          throw new Error('simulated network drop');
        }
        return src.openRead(path, offset);
      },
    });

    const openWriteCalls: Array<{ resume?: boolean }> = [];
    const trackedDst = wrapFs(dst, {
      openWrite: async (path: string, size?: number, opts?: { resume?: boolean }) => {
        openWriteCalls.push({ resume: opts?.resume });
        return dst.openWrite(path, size, opts);
      },
    });

    const queue = new TransferQueue();
    const id = queue.enqueue({
      name: 'big.bin',
      direction: 'up',
      src: flakySrc,
      srcPath: '/big.bin',
      dst: trackedDst,
      dstPath: '/big.bin',
      size: 1000,
      isDir: false,
    });

    const errored = await waitForState(queue, id, TERMINAL);
    expect(errored.state).toBe('error');
    // The pre-existing partial must survive the failed first attempt.
    await expect(readText(dst, '/big.bin')).resolves.toBe(full.slice(0, 500));

    queue.retry(id);
    const done = await waitForState(queue, id, TERMINAL);
    expect(done.state).toBe('done');

    await expect(readText(dst, '/big.bin')).resolves.toBe(full);
    expect(openWriteCalls.length).toBe(2);
    expect(openWriteCalls[0].resume).toBe(false);
    expect(openWriteCalls[1].resume).toBe(true);
  });

  it("a brand-new job's first run is fresh (resume: false), not resumed", async () => {
    const src = new MockFS('src');
    const dst = new MockFS('dst');
    await writeFile(src, '/fresh.txt', 'brand new contents');

    const openWriteCalls: Array<{ resume?: boolean }> = [];
    const trackedDst = wrapFs(dst, {
      openWrite: async (path: string, size?: number, opts?: { resume?: boolean }) => {
        openWriteCalls.push({ resume: opts?.resume });
        return dst.openWrite(path, size, opts);
      },
    });

    const queue = new TransferQueue();
    const id = queue.enqueue({
      name: 'fresh.txt',
      direction: 'up',
      src,
      srcPath: '/fresh.txt',
      dst: trackedDst,
      dstPath: '/fresh.txt',
      size: 19,
      isDir: false,
    });

    const job = await waitForState(queue, id, TERMINAL);
    expect(job.state).toBe('done');
    expect(openWriteCalls.length).toBe(1);
    expect(openWriteCalls[0].resume).toBe(false);
  });

  it('isolates a throwing subscriber from the queue and from other listeners', async () => {
    const src = new MockFS('src');
    const dst = new MockFS('dst');
    await writeFile(src, '/iso.txt', 'isolation test');

    const queue = new TransferQueue();
    queue.subscribe(() => {
      throw new Error('boom: a misbehaving subscriber');
    });
    const goodSnapshots: TransferJob[][] = [];
    queue.subscribe((jobs) => {
      goodSnapshots.push(jobs);
    });

    const id = queue.enqueue({
      name: 'iso.txt',
      direction: 'up',
      src,
      srcPath: '/iso.txt',
      dst,
      dstPath: '/iso.txt',
      size: 14,
      isDir: false,
    });

    const job = await waitForState(queue, id, TERMINAL);
    expect(job.state).toBe('done');

    expect(goodSnapshots.length).toBeGreaterThan(0);
    const sawDone = goodSnapshots.some((snap) =>
      snap.some((j) => j.id === id && j.state === 'done'),
    );
    expect(sawDone).toBe(true);
  });
});

describe('uniqueName', () => {
  it('returns the original name when free', async () => {
    const dst = new MockFS('dst');
    await expect(uniqueName(dst, '/', 'brandnew.txt')).resolves.toBe('brandnew.txt');
  });

  it('finds the first free numbered variant', async () => {
    const dst = new MockFS('dst');
    await writeFile(dst, '/dup.txt', 'one');
    await expect(uniqueName(dst, '/', 'dup.txt')).resolves.toBe('dup (1).txt');

    await writeFile(dst, '/dup (1).txt', 'two');
    await expect(uniqueName(dst, '/', 'dup.txt')).resolves.toBe('dup (2).txt');
  });

  it('handles dotfiles without splitting an extension', async () => {
    const dst = new MockFS('dst');
    await writeFile(dst, '/.env', 'secret');
    await expect(uniqueName(dst, '/', '.env')).resolves.toBe('.env (1)');
  });
});
