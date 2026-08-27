export interface QueueItem {
  id: string;
  label: string;
  direction: 'up' | 'down';
  progress: number; // 0..1
  done: boolean;
}

export function TransferQueue({ items }: { items: QueueItem[] }) {
  return (
    <div className="border-t border-border bg-surface px-3 py-1 text-[11px]">
      <div className="text-muted uppercase tracking-wide mb-0.5">Transfer queue</div>
      {items.length === 0 && <div className="text-muted">No transfers.</div>}
      {items.map((it) => (
        <div key={it.id} className="flex items-center gap-2">
          <span>{it.direction === 'up' ? '⬆' : '⬇'}</span>
          <span className="truncate flex-1">{it.label}</span>
          <span className="text-muted">{it.done ? '✓' : `${Math.round(it.progress * 100)}%`}</span>
        </div>
      ))}
    </div>
  );
}
