import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FileSystem, FsEntry } from '../fs/FileSystem';
import { joinPath, parentPath } from '../fs/FileSystem';
import { describeError } from '../fs/describeError';
import { IconFolder, IconFile, IconUp, IconDown, IconRefresh, IconNewFolder, IconTrash } from './icons';
import { PromptModal } from './PromptModal';
import { PropertiesDialog } from './PropertiesDialog';

/** Small inline eye / eye-off glyph for the hidden-files toggle. */
function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
      {off && <path d="M3 3l18 18" />}
    </svg>
  );
}

/** Fixed height (px) of one file row; used by the windowing math below. */
const ROW_H = 22;
/** Extra rows rendered above/below the viewport to avoid blank flashes while scrolling. */
const OVERSCAN = 6;

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
  /** Bumped externally (e.g. when a transfer completes into this pane) to force
   * a re-list of the current directory, without resetting cwd or selection. */
  refreshSignal?: number;
}

// Module-level "current drag" — simpler and more robust than serializing entries
// through the HTML5 dataTransfer payload (which can't carry arbitrary objects).
// Records the drag's source side so a drop handler can refuse a same-pane drop.
let currentDrag: { side?: 'local' | 'remote'; entries: FsEntry[] } | null = null;

export function fmtSize(n?: number): string {
  if (n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtDate(ms?: number): string {
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
  refreshSignal,
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
  const [showProperties, setShowProperties] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const lastAnchorRef = useRef<string | null>(null);
  const hoveredRef = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  // Index (into `rows`) of the keyboard-active row, for arrow-key navigation and
  // aria-activedescendant. -1 = nothing active yet.
  const [activeIdx, setActiveIdx] = useState(-1);
  const listId = useId();

  const reload = () => setRefreshKey((k) => k + 1);

  useEffect(() => {
    let alive = true;
    setError(null);
    fs.list(cwd)
      .then((e) => alive && setEntries(e))
      .catch((err) => alive && setError(describeError(err)));
    return () => {
      alive = false;
    };
  }, [fs, cwd, refreshKey, refreshSignal]);

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
    setActiveIdx(-1);
  }, [cwd, fs]);

  useEffect(() => {
    onCwdChange?.(cwd);
  }, [cwd, onCwdChange]);

  const hiddenCount = useMemo(
    () => entries.filter((e) => e.name.startsWith('.')).length,
    [entries],
  );

  const rows = useMemo(() => {
    const dirRank = (e: FsEntry) => (e.kind === 'dir' ? 0 : 1);
    const visible = showHidden ? entries : entries.filter((e) => !e.name.startsWith('.'));
    return [...visible].sort((a, b) => {
      if (dirRank(a) !== dirRank(b)) return dirRank(a) - dirRank(b); // folders first, always
      if (sortKey === 'size') return (a.size ?? 0) - (b.size ?? 0);
      if (sortKey === 'mtime') return (a.mtime ?? 0) - (b.mtime ?? 0);
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
  }, [entries, sortKey, showHidden]);

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

  // Ensure the row at `idx` is within the scroll viewport (used by keyboard nav,
  // which must scroll the active row into view since the list is windowed).
  const scrollRowIntoView = (idx: number) => {
    const el = scrollRef.current;
    if (!el || !el.clientHeight) return;
    const top = idx * ROW_H;
    const bottom = top + ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  };

  const moveActive = (delta: number) => {
    if (rows.length === 0) return;
    setActiveIdx((prev) => {
      const start = prev < 0 ? (delta > 0 ? -1 : rows.length) : prev;
      const next = Math.max(0, Math.min(rows.length - 1, start + delta));
      const row = rows[next];
      if (row) {
        setSelected(new Set([row.path]));
        lastAnchorRef.current = row.path;
        scrollRowIntoView(next);
      }
      return next;
    });
  };

  const onListKeyDown = (evt: React.KeyboardEvent) => {
    if (evt.key === 'ArrowDown') {
      evt.preventDefault();
      moveActive(1);
    } else if (evt.key === 'ArrowUp') {
      evt.preventDefault();
      moveActive(-1);
    } else if (evt.key === 'Home') {
      evt.preventDefault();
      moveActive(-rows.length);
    } else if (evt.key === 'End') {
      evt.preventDefault();
      moveActive(rows.length);
    } else if (evt.key === 'Enter') {
      const row = activeIdx >= 0 ? rows[activeIdx] : undefined;
      if (row?.kind === 'dir') {
        evt.preventDefault();
        setCwd(row.path);
      }
    }
  };

  const selectRow = (e: FsEntry, evt: React.MouseEvent) => {
    setActiveIdx(rows.findIndex((r) => r.path === e.path));
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

  // --- Row windowing ---------------------------------------------------------
  // Measure the scroll viewport so we can render only the visible slice of rows.
  // jsdom reports 0 for clientHeight, so viewportH stays 0 there and we fall back
  // to rendering every row (see `windowed` below) — that keeps tests, which assert
  // on specific rows, working while still virtualizing in a real browser.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewportH(el.clientHeight);
    measure();
    const RO = (window as unknown as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (!RO) return;
    const ro = new RO(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // When the height is unknown (0 — jsdom, or before first measure) render ALL rows.
  const virtualize = viewportH > 0;
  const total = rows.length;
  const startIdx = virtualize ? Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN) : 0;
  const visibleCount = virtualize
    ? Math.ceil(viewportH / ROW_H) + OVERSCAN * 2
    : total;
  const endIdx = virtualize ? Math.min(total, startIdx + visibleCount) : total;
  const visibleRows = rows.slice(startIdx, endIdx);
  const padTop = startIdx * ROW_H;
  const padBottom = Math.max(0, (total - endIdx) * ROW_H);

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
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-muted hover:bg-accent/10 hover:text-fg disabled:opacity-40 disabled:pointer-events-none"
          disabled={selectedEntries.length !== 1}
          onClick={() => setShowProperties(true)}
          title="Properties"
        >
          Properties
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
        <button
          className={`ml-auto flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-accent/10 hover:text-fg ${
            showHidden ? 'text-fg bg-accent/10' : 'text-muted'
          }`}
          aria-pressed={showHidden}
          onClick={() => setShowHidden((v) => !v)}
          title={showHidden ? 'Hide dotfiles' : 'Show hidden files'}
        >
          <EyeIcon off={!showHidden} /> Hidden
          {!showHidden && hiddenCount > 0 && (
            <span className="text-muted">({hiddenCount})</span>
          )}
        </button>
      </div>
      {actionError && (
        <div role="alert" className="px-2 py-1 text-[11px] text-danger border-b border-border">{actionError}</div>
      )}
      <div className="grid grid-cols-[1fr_80px_130px] px-2 py-1 text-[11px] text-muted border-b border-border">
        <button className="text-left" onClick={() => setSortKey('name')}>Name</button>
        <button className="text-right" onClick={() => setSortKey('size')}>Size</button>
        <button className="text-right" onClick={() => setSortKey('mtime')}>Modified</button>
      </div>
      <div
        ref={scrollRef}
        role="listbox"
        aria-label={`${header} file list`}
        aria-activedescendant={activeIdx >= 0 ? `${listId}-opt-${activeIdx}` : undefined}
        tabIndex={0}
        className="flex-1 min-h-0 overflow-auto font-mono text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-accent"
        onScroll={(evt) => setScrollTop(evt.currentTarget.scrollTop)}
        onKeyDown={onListKeyDown}
      >
        {error && <div role="alert" className="px-2 py-2 text-danger">{error}</div>}
        <div style={{ paddingTop: padTop, paddingBottom: padBottom }}>
          {visibleRows.map((e, i) => {
            const idx = startIdx + i;
            const isSel = selected.has(e.path);
            return (
              <div
                key={e.path}
                id={`${listId}-opt-${idx}`}
                role="option"
                aria-selected={isSel}
                draggable
                className={`grid grid-cols-[1fr_80px_130px] px-2 py-0.5 cursor-default border-l-2 ${
                  isSel
                    ? 'selected bg-accent border-accent text-accent-fg font-medium'
                    : 'border-transparent hover:bg-accent/10'
                }`}
                onClick={(evt) => selectRow(e, evt)}
                onDoubleClick={() => e.kind === 'dir' && setCwd(e.path)}
                onDragStart={(evt) => handleDragStart(e, evt)}
              >
                <span className="flex items-center gap-1 truncate">
                  {e.kind === 'dir' ? <IconFolder /> : <IconFile />}
                  {e.name}
                </span>
                <span className={`text-right ${isSel ? 'text-accent-fg/80' : 'text-muted'}`}>
                  {e.kind === 'dir' ? '' : fmtSize(e.size)}
                </span>
                <span className={`text-right ${isSel ? 'text-accent-fg/80' : 'text-muted'}`}>
                  {fmtDate(e.mtime)}
                </span>
              </div>
            );
          })}
        </div>
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
      {showProperties && selectedEntries.length === 1 && (
        <PropertiesDialog
          fs={fs}
          entry={selectedEntries[0]}
          onClose={() => setShowProperties(false)}
          onApplied={() => {
            setShowProperties(false);
            reload();
          }}
        />
      )}
    </div>
  );
}
