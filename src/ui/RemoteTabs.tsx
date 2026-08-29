import { useApp } from '../state/AppProvider';

/**
 * Tab strip for open remote sessions. Click a tab to switch; the × closes it
 * (tearing down that connection); the + opens the Connect dialog for a new
 * session while leaving existing tabs open. Hidden when nothing is connected.
 */
export function RemoteTabs() {
  const { remoteSessions, switchSession, closeSession, openNewSession } = useApp();
  if (remoteSessions.length === 0) return null;

  return (
    <div
      role="tablist"
      aria-label="Remote sessions"
      className="flex items-stretch gap-0.5 px-1 pt-1 bg-surface border-b border-border text-[12px] overflow-x-auto"
    >
      {remoteSessions.map((s) => (
        <div
          key={s.id}
          role="tab"
          aria-selected={s.active}
          title={s.label}
          onClick={() => switchSession(s.id)}
          className={`group flex items-center gap-1 px-2 py-1 cursor-pointer rounded-t border border-b-0 ${
            s.active
              ? 'bg-bg border-border text-text font-medium'
              : 'bg-transparent border-transparent text-muted hover:bg-accent/5'
          }`}
        >
          {s.dropped && (
            <span className="text-danger" title="Disconnected">
              ⚠
            </span>
          )}
          <span className="truncate max-w-[160px]">{s.label}</span>
          <button
            type="button"
            className="text-muted hover:text-danger px-0.5 leading-none"
            title="Close session"
            aria-label={`Close session ${s.label}`}
            onClick={(e) => {
              e.stopPropagation();
              closeSession(s.id);
            }}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="px-2 py-1 text-muted hover:text-accent"
        title="New session"
        aria-label="New session"
        onClick={openNewSession}
      >
        +
      </button>
    </div>
  );
}
