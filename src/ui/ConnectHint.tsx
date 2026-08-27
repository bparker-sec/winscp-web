interface Props {
  connecting: boolean;
  error?: string | null;
  onConnect: () => void;
}

export function ConnectHint({ connecting, error, onConnect }: Props) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 p-6 text-center">
      <div className="text-muted">Your files live in OneDrive.</div>
      <button
        className="h-8 px-4 rounded bg-accent text-accent-fg disabled:opacity-60"
        onClick={onConnect}
        disabled={connecting}
      >
        {connecting ? 'Connecting…' : 'Connect OneDrive'}
      </button>
      {error && <div className="text-danger text-[12px] max-w-xs">{error}</div>}
    </div>
  );
}
