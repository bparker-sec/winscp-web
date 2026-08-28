import { useApp } from '../state/AppProvider';

export function RemoteConnectHint() {
  const { openConnectDialog, remoteError } = useApp();
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 p-6 text-center">
      <div className="text-muted">Connect to an SFTP/SCP server.</div>
      <button
        className="h-8 px-4 rounded bg-accent text-accent-fg"
        onClick={openConnectDialog}
      >
        Connect…
      </button>
      {remoteError && (
        <div role="alert" className="text-danger text-[12px] max-w-xs">
          {remoteError}
        </div>
      )}
    </div>
  );
}
