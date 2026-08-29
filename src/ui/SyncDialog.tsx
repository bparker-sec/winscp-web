import { useState } from 'react';
import { Modal } from './Modal';
import { useApp } from '../state/AppProvider';
import type { SyncMode, CompareBy } from '../transfer/sync';

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

type Summary = { copy: number; mkdir: number; del: number; bytes: number } | null;

export function SyncDialog() {
  const { closeSync, previewSync, applySync, localCwd, remoteCwd } = useApp();

  const [from, setFrom] = useState<'local' | 'remote'>('local');
  const [mode, setMode] = useState<SyncMode>('update');
  const [compareBy, setCompareBy] = useState<CompareBy>('size-mtime');
  const [summary, setSummary] = useState<Summary>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const srcLabel = from === 'local' ? `OneDrive · ${localCwd}` : `Server · ${remoteCwd}`;
  const dstLabel = from === 'local' ? `Server · ${remoteCwd}` : `OneDrive · ${localCwd}`;

  const req = { from, mode, compareBy };

  const runPreview = async () => {
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const s = await previewSync(req);
      setSummary({ copy: s.copy, mkdir: s.mkdir, del: s.del, bytes: s.bytes });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const runApply = async () => {
    setBusy(true);
    setError(null);
    try {
      await applySync(req);
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Any option change invalidates the preview.
  const reset = () => {
    setSummary(null);
    setDone(false);
  };

  const nothingToDo = summary !== null && summary.copy === 0 && summary.mkdir === 0 && summary.del === 0;

  return (
    <Modal title="Synchronize folders" onClose={closeSync}>
      <div className="flex flex-col gap-3 text-[13px]">
        <div>
          <div className="text-[12px] uppercase tracking-wide text-muted mb-1">Direction</div>
          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                checked={from === 'local'}
                onChange={() => {
                  setFrom('local');
                  reset();
                }}
              />
              <span>OneDrive → Server (upload changes)</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                checked={from === 'remote'}
                onChange={() => {
                  setFrom('remote');
                  reset();
                }}
              />
              <span>Server → OneDrive (download changes)</span>
            </label>
          </div>
          <div className="text-muted text-[11px] mt-1">
            Source <span className="font-mono">{srcLabel}</span> → Destination{' '}
            <span className="font-mono">{dstLabel}</span>. Uses each pane's current folder.
          </div>
        </div>

        <div>
          <div className="text-[12px] uppercase tracking-wide text-muted mb-1">What to do</div>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              checked={mode === 'update'}
              onChange={() => {
                setMode('update');
                reset();
              }}
            />
            <span>Update — copy new and changed files only</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              checked={mode === 'mirror'}
              onChange={() => {
                setMode('mirror');
                reset();
              }}
            />
            <span>
              Mirror — make the destination match exactly
              <span className="text-danger"> (deletes extra files there)</span>
            </span>
          </label>
        </div>

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={compareBy === 'size-mtime'}
            onChange={(e) => {
              setCompareBy(e.target.checked ? 'size-mtime' : 'size');
              reset();
            }}
          />
          <span>Also re-copy when the source file is newer (not just a different size)</span>
        </label>

        {error && <div className="text-danger text-[12px] break-words">{error}</div>}

        {summary && !done && (
          <div className="border border-border rounded px-2 py-1.5 text-[12px]">
            {nothingToDo ? (
              <span className="text-muted">Everything is already up to date — nothing to do.</span>
            ) : (
              <span>
                Will copy <b>{summary.copy}</b> file{summary.copy === 1 ? '' : 's'} ({fmtBytes(summary.bytes)}),
                create <b>{summary.mkdir}</b> folder{summary.mkdir === 1 ? '' : 's'}
                {mode === 'mirror' && (
                  <>
                    , and <span className="text-danger">delete <b>{summary.del}</b></span> extra item
                    {summary.del === 1 ? '' : 's'}
                  </>
                )}
                .
              </span>
            )}
          </div>
        )}

        {done && (
          <div className="border border-border rounded px-2 py-1.5 text-[12px] text-muted">
            Synchronization started — copies appear in the transfer queue below.
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" className="h-8 px-3 rounded border border-border" onClick={closeSync}>
            {done ? 'Close' : 'Cancel'}
          </button>
          {!done && (
            <button
              type="button"
              className="h-8 px-3 rounded border border-border hover:bg-accent/10 disabled:opacity-40"
              onClick={() => void runPreview()}
              disabled={busy}
            >
              {busy && !summary ? 'Checking…' : 'Preview'}
            </button>
          )}
          {!done && (
            <button
              type="button"
              className="h-8 px-3 rounded bg-accent text-accent-fg disabled:opacity-40"
              onClick={() => void runApply()}
              disabled={busy || summary === null || nothingToDo}
              title={summary === null ? 'Preview first' : undefined}
            >
              Synchronize
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
