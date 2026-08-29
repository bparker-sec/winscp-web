import { useApp } from '../state/AppProvider';

export function StatusTile() {
  const { remote } = useApp();
  return (
    <div className="widget-card flex flex-col h-full bg-surface p-2 text-[11px]">
      <div className="flex items-center gap-2 mb-1">
        <span className="font-semibold">Skiff</span>
        <span className="ml-auto text-muted">{remote?.label ?? 'no session'} ●</span>
      </div>
      <div className="text-muted">No active transfers.</div>
      {/* TODO(later plan): wire to full-app navigation once host routing exists. */}
      <button
        className="mt-auto h-7 rounded bg-accent text-accent-fg"
        onClick={() => {
          /* placeholder: full-app navigation added in a later plan */
        }}
      >
        ↗ Open full app
      </button>
    </div>
  );
}
