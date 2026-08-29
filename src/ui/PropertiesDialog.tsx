import { useState } from 'react';
import type { FileSystem, FsEntry } from '../fs/FileSystem';
import { describeError } from '../fs/describeError';
import { Modal } from './Modal';
import { fmtSize, fmtDate } from './PaneView';

interface Props {
  fs: FileSystem;
  entry: FsEntry;
  onClose: () => void;
  /** Called after a successful chmod so the pane can re-list its directory. */
  onApplied: () => void;
}

// POSIX permission bit for a given class (owner/group/other) × perm (r/w/x).
const CLASSES = [
  { key: 'owner', label: 'Owner' },
  { key: 'group', label: 'Group' },
  { key: 'other', label: 'Other' },
] as const;
const PERMS = [
  { key: 'r', label: 'Read', bit: 4 },
  { key: 'w', label: 'Write', bit: 2 },
  { key: 'x', label: 'Exec', bit: 1 },
] as const;

// Bit offset (in octal digits) for each class: owner=6, group=3, other=0.
const CLASS_SHIFT: Record<string, number> = { owner: 6, group: 3, other: 0 };

function octal(permBits: number): string {
  return '0' + (permBits & 0o777).toString(8).padStart(3, '0');
}

const kindLabel = (k: FsEntry['kind']) =>
  k === 'dir' ? 'Directory' : k === 'symlink' ? 'Symbolic link' : 'File';

export function PropertiesDialog({ fs, entry, onClose, onApplied }: Props) {
  const editable = typeof fs.chmod === 'function' && typeof entry.mode === 'number';
  // Only the low 9 permission bits are edited; upper (type) bits are preserved on apply.
  const [permBits, setPermBits] = useState<number>((entry.mode ?? 0) & 0o777);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const has = (cls: string, bit: number) => (permBits & (bit << CLASS_SHIFT[cls])) !== 0;
  const toggle = (cls: string, bit: number) => {
    const mask = bit << CLASS_SHIFT[cls];
    setPermBits((p) => p ^ mask);
  };

  const apply = async () => {
    if (!editable || !fs.chmod) return;
    setBusy(true);
    setError(null);
    try {
      // Preserve any high (file-type) bits from the original mode.
      const upper = (entry.mode ?? 0) & ~0o777;
      await fs.chmod(entry.path, upper | permBits);
      onApplied();
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  };

  return (
    <Modal title="Properties" onClose={onClose}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm mb-2">
        <dt className="text-muted">Name</dt>
        <dd className="font-mono break-all">{entry.name}</dd>
        <dt className="text-muted">Path</dt>
        <dd className="font-mono break-all">{entry.path}</dd>
        <dt className="text-muted">Kind</dt>
        <dd>{kindLabel(entry.kind)}</dd>
        <dt className="text-muted">Size</dt>
        <dd>{entry.kind === 'dir' ? '—' : fmtSize(entry.size) || '—'}</dd>
        <dt className="text-muted">Modified</dt>
        <dd>{fmtDate(entry.mtime) || '—'}</dd>
      </dl>

      {editable && (
        <div className="border-t border-border pt-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] text-muted uppercase tracking-wide">Permissions</span>
            <span className="font-mono text-sm" aria-label="octal permissions">
              {octal(permBits)}
            </span>
          </div>
          <table className="text-sm w-full">
            <thead>
              <tr className="text-muted text-[11px]">
                <th className="text-left font-normal"></th>
                {PERMS.map((p) => (
                  <th key={p.key} className="font-normal px-2">{p.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {CLASSES.map((cls) => (
                <tr key={cls.key}>
                  <td className="text-muted pr-2">{cls.label}</td>
                  {PERMS.map((p) => (
                    <td key={p.key} className="text-center px-2 py-0.5">
                      <input
                        type="checkbox"
                        aria-label={`${cls.label} ${p.label}`}
                        checked={has(cls.key, p.bit)}
                        onChange={() => toggle(cls.key, p.bit)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {error && <div className="text-danger text-[11px] mt-2">{error}</div>}
          <div className="flex justify-end gap-2 mt-3">
            <button
              type="button"
              className="px-3 py-1 text-sm rounded border border-border hover:bg-accent/10"
              onClick={onClose}
            >
              Close
            </button>
            <button
              type="button"
              className="px-3 py-1 text-sm rounded text-white bg-accent disabled:opacity-40"
              disabled={busy}
              onClick={apply}
            >
              {busy ? 'Applying…' : 'Apply'}
            </button>
          </div>
        </div>
      )}

      {!editable && (
        <div className="flex justify-end mt-2">
          <button
            type="button"
            className="px-3 py-1 text-sm rounded border border-border hover:bg-accent/10"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      )}
    </Modal>
  );
}
