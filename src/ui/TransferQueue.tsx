import { useApp } from '../state/AppProvider';
import type { TransferJob } from '../transfer/queue';

function fmtSize(n?: number): string {
  if (n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
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

function Row({ job }: { job: TransferJob }) {
  const { cancelJob, retryJob } = useApp();
  const pct = job.size ? Math.min(100, Math.round((job.bytes / job.size) * 100)) : undefined;
  const cancellable = job.state === 'queued' || job.state === 'active' || job.state === 'conflict';
  const retryable = job.state === 'error' || job.state === 'cancelled';

  return (
    <div className="py-0.5">
      <div className="flex items-center gap-2">
        <span>{job.direction === 'up' ? '⬆' : '⬇'}</span>
        <span className="truncate flex-1" title={job.name}>
          {job.name}
          {job.retried && (job.state === 'active' || job.state === 'conflict' || job.state === 'done') && (
            <span className="ml-1 text-muted" title="Resumed from a previous attempt">
              ↻ resumed
            </span>
          )}
        </span>
        <div className="w-24 h-1.5 rounded bg-black/10 dark:bg-white/10 overflow-hidden shrink-0">
          <div
            className={`h-full bg-accent ${pct === undefined && (job.state === 'active' || job.state === 'conflict') ? 'animate-pulse w-full' : ''}`}
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

  return (
    <div className="border-t border-border bg-surface px-3 py-1 text-[11px] max-h-40 overflow-auto">
      <div className="flex items-center gap-2 text-muted uppercase tracking-wide mb-0.5">
        <span>Transfer queue</span>
        <span>({jobs.length})</span>
        <button className="ml-auto normal-case hover:text-accent" onClick={clearFinished}>
          Clear finished
        </button>
        <button className="normal-case hover:text-danger" onClick={cancelAllJobs}>
          Cancel all
        </button>
      </div>
      {jobs.length === 0 && <div className="text-muted">No transfers.</div>}
      {jobs.map((job) => (
        <Row key={job.id} job={job} />
      ))}
    </div>
  );
}
