import { useApp } from '../state/AppProvider';

export function RemoteConnectHint() {
  const { connections, vaultState, connectSaved, openConnectDialog, openConnectionManager, remoteError } = useApp();

  const onConnect = (id: string) => {
    // connectSaved reports failures via remoteError; swallow the rejection
    // here so it doesn't surface as an unhandled promise rejection.
    void connectSaved(id).catch(() => {});
  };

  return (
    <div className="flex flex-col h-full p-6 gap-3 overflow-auto">
      <div className="text-muted text-[12px] uppercase tracking-wide">Connections</div>

      {connections.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 gap-3 text-center">
          <div className="text-muted">No saved connections.</div>
          <button className="h-8 px-4 rounded bg-accent text-accent-fg" onClick={openConnectDialog}>
            New connection…
          </button>
        </div>
      ) : (
        <>
          <ul className="flex flex-col gap-1">
            {connections.map((conn) => (
              <li key={conn.id}>
                <button
                  type="button"
                  className="w-full text-left px-2 py-1.5 rounded border border-border hover:bg-black/5 dark:hover:bg-white/10"
                  onClick={() => onConnect(conn.id)}
                >
                  <div className="font-medium truncate flex items-center gap-1">
                    {conn.name}
                    {!conn.alwaysPrompt && <span title="Secret stored">🔒</span>}
                  </div>
                  <div className="text-muted text-[12px] truncate">
                    {conn.username}@{conn.host}:{conn.port}
                  </div>
                </button>
              </li>
            ))}
          </ul>

          <div className="flex flex-col items-center gap-2 mt-2">
            <button className="h-8 px-4 rounded bg-accent text-accent-fg" onClick={openConnectDialog}>
              New connection…
            </button>
            {vaultState === 'locked' && (
              <button className="text-[12px] text-muted underline" onClick={openConnectionManager}>
                Unlock saved connections
              </button>
            )}
          </div>
        </>
      )}

      {remoteError && (
        <div role="alert" className="text-danger text-[12px] max-w-xs mx-auto text-center">
          {remoteError}
        </div>
      )}
    </div>
  );
}
