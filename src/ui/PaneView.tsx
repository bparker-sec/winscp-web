import { useEffect, useMemo, useRef, useState } from 'react';
import type { FileSystem, FsEntry } from '../fs/FileSystem';
import { FsError, joinPath, parentPath } from '../fs/FileSystem';
import { IconFolder, IconFile, IconUp, IconDown, IconRefresh, IconNewFolder, IconTrash } from './icons';
import { PromptModal } from './PromptModal';

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
  /** Invoked when entries dragged out of the OTHER pane are dropped onto this one. */
  onDropIn?: (entries: FsEntry[]) => void;
  /**
   * Which side this pane represents. Used to guard against a same-pane
   * self-drop (dragging within one pane and dropping back onto it), which
   * would otherwise build a transfer job with the wrong src/dst FileSystem.
   */
  side?: 'local' | 'remote';
}

// Module-level "current drag" — simpler and more robust than serializing entries
// through the HTML5 dataTransfer payload (which can't carry arbitrary objects).
// Records the drag's source side so a drop handler can refuse a same-pane drop.
let currentDrag: { side?: 'local' | 'remote'; entries: FsEntry[] } | null = null;

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
  side,
}: Props) {
  const [cwd, setCwd] = useState(initialPath);
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [showRename, setShowRename] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const lastAnchorRef = useRef<string | null>(null);
  const hoveredRef = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const reload = () => setRefreshKey((k) => k + 1);

  useEffect(() => {
    let alive = true;
    setError(null);
    fs.list(cwd)
      .then((e) => alive && setEntries(e))
      .catch((err) => alive && setError(String(err?.message ?? err)));
    return () => {
      alive = false;
    };
  }, [fs, cwd, refreshKey]);

  const describeError = (e: unknown): string =>
    e instanceof FsError ? `${e.code}: ${e.message}` : String((e as Error)?.message ?? e);

  const runAction = async (fn: () => Promise<void>) => {
    try {
      await fn();
      setActionError(null);
      reload();
    } catch (e) {
      setActionError(describeError(e));
    }
  };

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
    currentDrag = { side, entries: dragEntries };
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
    if (!drag || !drag.entries.length) return;
    // Guard against a same-pane self-drop: dragging within one pane and dropping
    // back onto it would otherwise build a transfer job against the wrong
    // src/dst FileSystem (this pane's own fs on both ends).
    if (side !== undefined && drag.side === side) return;
    onDropIn(drag.entries);
  };

  const handleUp = () => {
    if (cwd === '/') return;
    setCwd(parentPath(cwd));
  };

  const handleNewFolder = (name: string) => {
    setShowNewFolder(false);
    if (!name) return;
    void runAction(async () => {
      await fs.mkdir(joinPath(cwd, name));
    });
  };

  const handleRename = (newName: string) => {
    setShowRename(false);
    if (!newName || selectedEntries.length !== 1) return;
    const entry = selectedEntries[0];
    void runAction(async () => {
      await fs.rename(entry.path, joinPath(cwd, newName));
    });
  };

  const handleDeleteConfirm = () => {
    setShowDelete(false);
    const toDelete = selectedEntries;
    if (!toDelete.length) return;
    void runAction(async () => {
      for (const entry of toDelete) {
        await fs.remove(entry.path, entry.kind === 'dir');
      }
      setSelected(new Set());
    });
  };

  const transferLabel = side === 'local' ? 'Upload →' : side === 'remote' ? '← Download' : 'Transfer';
  const transferTitle = side === 'local' ? 'Upload to remote' : side === 'remote' ? 'Download to local' : 'Transfer';

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
      <div className="px-2 py-1 border-b border-border flex flex-wrap items-center gap-1 text-[11px]">
        <button
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-muted hover:bg-accent/10 hover:text-fg disabled:opacity-40 disabled:pointer-events-none"
          disabled={cwd === '/'}
          onClick={handleUp}
          title="Up"
        >
          <IconUp /> Up
        </button>
        <button
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-muted hover:bg-accent/10 hover:text-fg"
          onClick={reload}
          title="Refresh"
        >
          <IconRefresh /> Refresh
        </button>
        <button
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-muted hover:bg-accent/10 hover:text-fg"
          onClick={() => setShowNewFolder(true)}
          title="New folder"
        >
          <IconNewFolder /> New folder
        </button>
        <button
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-muted hover:bg-accent/10 hover:text-fg disabled:opacity-40 disabled:pointer-events-none"
          disabled={selectedEntries.length !== 1}
          onClick={() => setShowRename(true)}
          title="Rename"
        >
          Rename
        </button>
        <button
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-muted hover:bg-danger/10 hover:text-danger disabled:opacity-40 disabled:pointer-events-none"
          disabled={selectedEntries.length === 0}
          onClick={() => setShowDelete(true)}
          title="Delete"
        >
          <IconTrash /> Delete
        </button>
        {onTransferOut && (
          <button
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-muted hover:bg-accent/10 hover:text-fg disabled:opacity-40 disabled:pointer-events-none"
            disabled={selectedEntries.length === 0}
            onClick={() => onTransferOut(selectedEntries)}
            title={transferTitle}
          >
            {side === 'remote' ? <IconDown /> : <IconUp />} {transferLabel}
          </button>
        )}
      </div>
      {actionError && (
        <div className="px-2 py-1 text-[11px] text-danger border-b border-border">{actionError}</div>
      )}
      <div className="grid grid-cols-[1fr_80px_130px] px-2 py-1 text-[11px] text-muted border-b border-border">
        <button className="text-left" onClick={() => setSortKey('name')}>Name</button>
        <button className="text-right" onClick={() => setSortKey('size')}>Size</button>
        <button className="text-right" onClick={() => setSortKey('mtime')}>Modified</button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto font-mono text-[12px]">
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
      {showNewFolder && (
        <PromptModal
          title="New folder"
          label="Folder name"
          confirmLabel="Create"
          onSubmit={handleNewFolder}
          onCancel={() => setShowNewFolder(false)}
        />
      )}
      {showRename && selectedEntries.length === 1 && (
        <PromptModal
          title="Rename"
          label="New name"
          initialValue={selectedEntries[0].name}
          confirmLabel="Rename"
          onSubmit={handleRename}
          onCancel={() => setShowRename(false)}
        />
      )}
      {showDelete && (
        <PromptModal
          title="Delete"
          prompt={false}
          message={`Delete ${selectedEntries.length} item(s)? This cannot be undone.`}
          confirmLabel="Delete"
          danger
          onSubmit={handleDeleteConfirm}
          onCancel={() => setShowDelete(false)}
        />
      )}
    </div>
  );
}
