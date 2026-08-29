import { useEffect, useState } from 'react';
import { useApp } from '../state/AppProvider';
import type { TransferJob } from '../transfer/queue';

function fmtSize(n?: number): string {
  if (n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Bytes/second as a human rate (B/s, KB/s, MB/s). */
function fmtRate(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '';
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`;
}

/** Elapsed milliseconds as a compact clock (m:ss, or s.s for < 10s). */
function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const secs = ms / 1000;
  if (secs < 10) return `${secs.toFixed(1)}s`;
  const total = Math.round(secs);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

/** Elapsed + average throughput for a job's current/last run, if it has run. */
function timing(job: TransferJob, now: number): { elapsedMs: number; rate: number } | null {
  if (job.startedAt === undefined) return null;
  const end = job.finishedAt ?? now;
  const elapsedMs = Math.max(0, end - job.startedAt);
  const transferred = Math.max(0, job.bytes - (job.startBytes ?? 0));
  const rate = elapsedMs > 0 ? transferred / (elapsedMs / 1000) : 0;
  return { elapsedMs, rate };
}

function stateLabel(job: TransferJob): string {
  switch (job.state) {
    case 'queued':
      return 'queued';
    case 'active':
    case 'conflict':
      return job.size ? `${Math.round((job.bytes / job.size) * 100)}%` : 'transferring…';
    case 'done':
      return 'done';
    case 'skipped':
      return 'skipped';
    case 'cancelled':
      return 'cancelled';
    case 'error':
      return 'error';
    default:
      return job.state;
  }
}

function Row({ job, now }: { job: TransferJob; now: number }) {
  const { cancelJob, retryJob } = useApp();
  const pct = job.size ? Math.min(100, Math.round((job.bytes / job.size) * 100)) : undefined;
  const cancellable = !job.restored && (job.state === 'queued' || job.state === 'active' || job.state === 'conflict');
  // Restored (previous-session) jobs have no live handles, so they can't be retried.
  const retryable = !job.restored && (job.state === 'error' || job.state === 'cancelled');

  const t = timing(job, now);
  const isActive = job.state === 'active' || job.state === 'conflict';
  const isDone = job.state === 'done';
  // Live rate while active; average rate once done. Elapsed shown in both.
  const meter =
    t && (isActive || isDone)
      ? [isActive || isDone ? fmtRate(t.rate) : '', fmtDuration(t.elapsedMs)].filter(Boolean).join(' · ')
      : '';

  return (
    <div className="py-0.5">
      <div className="flex items-center gap-2">
        <span aria-hidden="true">{job.direction === 'up' ? '⬆' : '⬇'}</span>
        <span className="truncate flex-1" title={job.name}>
          {job.name}
          {job.retried && (job.state === 'active' || job.state === 'conflict' || job.state === 'done') && (
            <span className="ml-1 text-muted" title="Resumed from a previous attempt">
              ↻ resumed
            </span>
          )}
          {job.restored && (
            <span className="ml-1 text-muted" title="From a previous session (history only)">
              · previous session
            </span>
          )}
        </span>
        <span className="text-muted w-28 text-right tabular-nums truncate" title={meter}>
          {meter}
        </span>
        <div className="w-24 h-1.5 rounded bg-black/10 dark:bg-white/10 overflow-hidden shrink-0">
          <div
            className={`h-full bg-accent ${pct === undefined && isActive ? 'motion-safe:animate-pulse w-full' : ''}`}
            style={pct !== undefined ? { width: `${job.state === 'done' ? 100 : pct}%` } : undefined}
          />
        </div>
        <span className="text-muted w-16 text-right truncate" title={stateLabel(job)}>
          {stateLabel(job)}
        </span>
        {job.size !== undefined && <span className="text-muted w-16 text-right">{fmtSize(job.size)}</span>}
        <span className="w-14 text-right">
          {cancellable && (
            <button className="text-muted hover:text-danger" onClick={() => cancelJob(job.id)}>
              Cancel
            </button>
          )}
          {retryable && (
            <button className="text-muted hover:text-accent" onClick={() => retryJob(job.id)}>
              Retry
            </button>
          )}
        </span>
      </div>
      {job.state === 'error' && job.error && (
        <div className="text-danger text-[11px] break-words pl-5 max-h-16 overflow-auto">{job.error}</div>
      )}
    </div>
  );
}

export function TransferQueue() {
  const { jobs, cancelAllJobs, clearFinished } = useApp();

  // Tick while any transfer is active so elapsed/rate advance smoothly even
  // between progress events (a stalled-but-active transfer still updates).
  const hasActive = jobs.some((j) => j.state === 'active' || j.state === 'conflict');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasActive) return;
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [hasActive]);
  const nowTs = hasActive ? now : Date.now();

  const activeCount = jobs.filter((j) => j.state === 'active' || j.state === 'conflict').length;
  const doneCount = jobs.filter((j) => j.state === 'done').length;

  return (
    <div
      className="border-t border-border bg-surface px-3 py-1 text-[11px] max-h-40 overflow-auto"
      role="region"
      aria-label="Transfer queue"
    >
      <div className="flex items-center gap-2 text-muted uppercase tracking-wide mb-0.5">
        <span>Transfer queue</span>
        <span>({jobs.length})</span>
        <span role="status" aria-live="polite" className="sr-only">
          {jobs.length === 0
            ? 'Transfer queue empty'
            : `${jobs.length} transfer${jobs.length === 1 ? '' : 's'}, ${activeCount} active, ${doneCount} complete`}
        </span>
        <button className="ml-auto normal-case hover:text-accent" onClick={clearFinished}>
          Clear finished
        </button>
        <button className="normal-case hover:text-danger" onClick={cancelAllJobs}>
          Cancel all
        </button>
      </div>
      {jobs.length === 0 && <div className="text-muted">No transfers.</div>}
      {jobs.map((job) => (
        <Row key={job.id} job={job} now={nowTs} />
      ))}
    </div>
  );
}
