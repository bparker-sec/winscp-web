import { useEffect, useMemo, useRef, useState } from 'react';
import type { FileSystem, FsEntry } from '../fs/FileSystem';
import { parentPath } from '../fs/FileSystem';
import { IconFolder, IconFile } from './icons';

type SortKey = 'name' | 'size' | 'mtime';

interface Props {
  fs: FileSystem;
  header: string;
  initialPath?: string;
  onDisconnect?: () => void;
  onSelectionChange?: (entries: FsEntry[]) => void;
  onCwdChange?: (path: string) => void;
  /** Invoked when the user asks to send the current selection to the other pane (F5, or dragging out). */
  onTransferOut?: (entries: FsEntry[]) => void;
  /** Invoked when entries dragged out of another pane are dropped onto this one. */
  onDropIn?: (entries: FsEntry[]) => void;
}

// Module-level "current drag" — simpler and more robust than serializing entries
// through the HTML5 dataTransfer payload (which can't carry arbitrary objects).
let currentDrag: { entries: FsEntry[] } | null = null;

function fmtSize(n?: number): string {
  if (n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtDate(ms?: number): string {
  if (!ms) return '';
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

export function PaneView({
  fs,
  header,
  initialPath = '/',
  onDisconnect,
  onSelectionChange,
  onCwdChange,
  onTransferOut,
  onDropIn,
}: Props) {
  const [cwd, setCwd] = useState(initialPath);
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const lastAnchorRef = useRef<string | null>(null);
  const hoveredRef = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    fs.list(cwd)
      .then((e) => alive && setEntries(e))
      .catch((err) => alive && setError(String(err?.message ?? err)));
    return () => {
      alive = false;
    };
  }, [fs, cwd]);

  // Reset selection when navigating.
  useEffect(() => {
    setSelected(new Set());
    lastAnchorRef.current = null;
  }, [cwd, fs]);

  useEffect(() => {
    onCwdChange?.(cwd);
  }, [cwd, onCwdChange]);

  const rows = useMemo(() => {
    const dirRank = (e: FsEntry) => (e.kind === 'dir' ? 0 : 1);
    return [...entries].sort((a, b) => {
      if (dirRank(a) !== dirRank(b)) return dirRank(a) - dirRank(b); // folders first, always
      if (sortKey === 'size') return (a.size ?? 0) - (b.size ?? 0);
      if (sortKey === 'mtime') return (a.mtime ?? 0) - (b.mtime ?? 0);
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
  }, [entries, sortKey]);

  const selectedEntries = useMemo(
    () => rows.filter((e) => selected.has(e.path)),
    [rows, selected],
  );

  useEffect(() => {
    onSelectionChange?.(selectedEntries);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, rows]);

  useEffect(() => {
    if (!onTransferOut) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'F5' || !hoveredRef.current) return;
      e.preventDefault();
      const toSend = selectedEntries.length ? selectedEntries : rows;
      if (toSend.length) onTransferOut(toSend);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onTransferOut, selectedEntries, rows]);

  const selectRow = (e: FsEntry, evt: React.MouseEvent) => {
    if (evt.shiftKey && lastAnchorRef.current) {
      const anchorIdx = rows.findIndex((r) => r.path === lastAnchorRef.current);
      const targetIdx = rows.findIndex((r) => r.path === e.path);
      if (anchorIdx !== -1 && targetIdx !== -1) {
        const [lo, hi] = anchorIdx < targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx];
        setSelected(new Set(rows.slice(lo, hi + 1).map((r) => r.path)));
        return;
      }
    }
    if (evt.ctrlKey || evt.metaKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(e.path)) next.delete(e.path);
        else next.add(e.path);
        return next;
      });
      lastAnchorRef.current = e.path;
      return;
    }
    setSelected(new Set([e.path]));
    lastAnchorRef.current = e.path;
  };

  const handleDragStart = (e: FsEntry, evt: React.DragEvent) => {
    const dragEntries = selected.has(e.path) && selectedEntries.length ? selectedEntries : [e];
    currentDrag = { entries: dragEntries };
    evt.dataTransfer.effectAllowed = 'copy';
    try {
      evt.dataTransfer.setData('text/plain', dragEntries.map((x) => x.name).join(', '));
    } catch {
      // Some browsers restrict setData in certain contexts; the drag still works via currentDrag.
    }
  };

  const handleDragOver = (evt: React.DragEvent) => {
    if (!onDropIn) return;
    evt.preventDefault();
    evt.dataTransfer.dropEffect = 'copy';
  };

  const handleDrop = (evt: React.DragEvent) => {
    if (!onDropIn) return;
    evt.preventDefault();
    const drag = currentDrag;
    currentDrag = null;
    if (drag && drag.entries.length) onDropIn(drag.entries);
  };

  return (
    <div
      ref={containerRef}
      className="flex flex-col h-full min-h-0 bg-surface"
      onMouseEnter={() => {
        hoveredRef.current = true;
      }}
      onMouseLeave={() => {
        hoveredRef.current = false;
      }}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div className="px-2 py-1 border-b border-border font-semibold flex items-center gap-2">
        <span className="truncate">{header}</span>
        <span className="text-muted font-normal truncate">· {cwd}</span>
        {onDisconnect && (
          <button
            className="ml-auto text-muted font-normal text-[11px] hover:text-danger"
            onClick={onDisconnect}
          >
            Disconnect
          </button>
        )}
      </div>
      <div className="grid grid-cols-[1fr_80px_130px] px-2 py-1 text-[11px] text-muted border-b border-border">
        <button className="text-left" onClick={() => setSortKey('name')}>Name</button>
        <button className="text-right" onClick={() => setSortKey('size')}>Size</button>
        <button className="text-right" onClick={() => setSortKey('mtime')}>Modified</button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto font-mono text-[12px]">
        {cwd !== '/' && (
          <button
            className="w-full text-left px-2 py-0.5 hover:bg-accent/10"
            onDoubleClick={() => setCwd(parentPath(cwd))}
            onClick={() => setCwd(parentPath(cwd))}
          >
            📁 ..
          </button>
        )}
        {error && <div className="px-2 py-2 text-danger">{error}</div>}
        {rows.map((e) => (
          <div
            key={e.path}
            draggable
            className={`grid grid-cols-[1fr_80px_130px] px-2 py-0.5 cursor-default ${
              selected.has(e.path) ? 'bg-accent/20' : 'hover:bg-accent/10'
            }`}
            onClick={(evt) => selectRow(e, evt)}
            onDoubleClick={() => e.kind === 'dir' && setCwd(e.path)}
            onDragStart={(evt) => handleDragStart(e, evt)}
          >
            <span className="flex items-center gap-1 truncate">
              {e.kind === 'dir' ? <IconFolder /> : <IconFile />}
              {e.name}
            </span>
            <span className="text-right text-muted">{e.kind === 'dir' ? '' : fmtSize(e.size)}</span>
            <span className="text-right text-muted">{fmtDate(e.mtime)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
