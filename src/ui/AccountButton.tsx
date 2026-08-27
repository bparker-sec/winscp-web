interface Props {
  signedIn: boolean;
  userName?: string;
  onConnect: () => void;
  onDisconnect: () => void;
}

export function AccountButton({ signedIn, userName, onConnect, onDisconnect }: Props) {
  if (!signedIn) {
    return (
      <button className="px-2 h-7 rounded text-text hover:bg-black/5 dark:hover:bg-white/10" onClick={onConnect}>
        Connect OneDrive
      </button>
    );
  }
  return (
    <button
      className="px-2 h-7 rounded text-text hover:bg-black/5 dark:hover:bg-white/10"
      title="Disconnect OneDrive"
      onClick={onDisconnect}
    >
      👤 {userName ?? 'OneDrive'} · Sign out
    </button>
  );
}
