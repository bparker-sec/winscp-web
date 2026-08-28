import { useEffect, useMemo, useState } from 'react';
import type { FileSystem, FsEntry } from '../fs/FileSystem';
import { parentPath } from '../fs/FileSystem';
import { IconFolder, IconFile } from './icons';

type SortKey = 'name' | 'size' | 'mtime';

interface Props {
  fs: FileSystem;
  header: string;
  initialPath?: string;
  onDisconnect?: () => void;
}

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

export function PaneView({ fs, header, initialPath = '/', onDisconnect }: Props) {
  const [cwd, setCwd] = useState(initialPath);
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

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

  const rows = useMemo(() => {
    const dirRank = (e: FsEntry) => (e.kind === 'dir' ? 0 : 1);
    return [...entries].sort((a, b) => {
      if (dirRank(a) !== dirRank(b)) return dirRank(a) - dirRank(b); // folders first, always
      if (sortKey === 'size') return (a.size ?? 0) - (b.size ?? 0);
      if (sortKey === 'mtime') return (a.mtime ?? 0) - (b.mtime ?? 0);
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
  }, [entries, sortKey]);

  return (
    <div className="flex flex-col h-full min-h-0 bg-surface">
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
            className={`grid grid-cols-[1fr_80px_130px] px-2 py-0.5 cursor-default ${
              selected.has(e.path) ? 'bg-accent/20' : 'hover:bg-accent/10'
            }`}
            onClick={() => setSelected(new Set([e.path]))}
            onDoubleClick={() => e.kind === 'dir' && setCwd(e.path)}
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
