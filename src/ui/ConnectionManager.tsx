import { Modal } from './Modal';
import { useApp } from '../state/AppProvider';
import type { SavedConnection } from '../connections/store';

export function ConnectionManager() {
  const {
    connections,
    vaultState,
    closeConnectionManager,
    connectSaved,
    deleteConnection,
    duplicateConnection,
    openConnectDialog,
    openConnectDialogPrefilled,
  } = useApp();

  const onConnect = (id: string) => {
    connectSaved(id);
    closeConnectionManager();
  };

  const onEdit = (conn: SavedConnection) => {
    openConnectDialogPrefilled({
      name: conn.name,
      host: conn.host,
      port: conn.port,
      username: conn.username,
      authMethod: conn.authMethod,
      alwaysPrompt: conn.alwaysPrompt,
    });
    closeConnectionManager();
  };

  const onDelete = (id: string, name: string) => {
    if (window.confirm(`Delete saved connection "${name}"?`)) {
      deleteConnection(id);
    }
  };

  const onNew = () => {
    openConnectDialog();
    closeConnectionManager();
  };

  return (
    <Modal title="Saved connections" onClose={closeConnectionManager}>
      <div className="flex flex-col gap-3">
        {vaultState === 'locked' && (
          <div className="text-[12px] text-muted flex items-center justify-between border border-border rounded px-2 py-1">
            <span>Some connections have secrets stored in a locked vault.</span>
          </div>
        )}

        {connections.length === 0 ? (
          <div className="text-muted text-[13px] text-center py-4">No saved connections yet.</div>
        ) : (
          <ul className="flex flex-col gap-1 max-h-[50vh] overflow-auto">
            {connections.map((conn) => (
              <li
                key={conn.id}
                className="flex items-center justify-between gap-2 px-2 py-1.5 rounded border border-border text-[13px]"
              >
                <div className="min-w-0">
                  <div className="font-medium truncate flex items-center gap-1">
                    {conn.name}
                    {!conn.alwaysPrompt && <span title="Secret stored">🔒</span>}
                  </div>
                  <div className="text-muted text-[12px] truncate">
                    {conn.username}@{conn.host}:{conn.port}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    className="h-7 px-2 rounded bg-accent text-accent-fg text-[12px]"
                    onClick={() => onConnect(conn.id)}
                  >
                    Connect
                  </button>
                  <button
                    className="h-7 px-2 rounded border border-border text-[12px]"
                    onClick={() => onEdit(conn)}
                  >
                    Edit
                  </button>
                  <button
                    className="h-7 px-2 rounded border border-border text-[12px]"
                    onClick={() => duplicateConnection(conn.id)}
                  >
                    Duplicate
                  </button>
                  <button
                    className="h-7 px-2 rounded border border-border text-danger text-[12px]"
                    onClick={() => onDelete(conn.id, conn.name)}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="flex justify-end gap-2 mt-2">
          <button type="button" className="h-8 px-3 rounded border border-border" onClick={closeConnectionManager}>
            Close
          </button>
          <button type="button" className="h-8 px-4 rounded bg-accent text-accent-fg" onClick={onNew}>
            New connection
          </button>
        </div>
      </div>
    </Modal>
  );
}
