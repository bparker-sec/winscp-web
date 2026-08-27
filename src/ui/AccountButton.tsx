interface Props {
  signedIn: boolean;
  connecting?: boolean;
  userName?: string;
  onConnect: () => void;
  onDisconnect: () => void;
}

export function AccountButton({ signedIn, connecting, userName, onConnect, onDisconnect }: Props) {
  if (!signedIn) {
    return (
      <button
        className="px-2 h-7 rounded text-text hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-60"
        onClick={onConnect}
        disabled={connecting}
      >
        {connecting ? 'Connecting…' : 'Connect OneDrive'}
      </button>
    );
  }
  return (
    <button
      className="px-2 h-7 rounded text-text hover:bg-black/5 dark:hover:bg-white/10"
      title="Disconnect OneDrive"
      aria-label={`Sign out of OneDrive${userName ? ` (${userName})` : ''}`}
      onClick={onDisconnect}
    >
      👤 {userName ?? 'OneDrive'} · Sign out
    </button>
  );
}
