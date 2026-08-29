import { IconMoon, IconSun, IconGear } from './icons';
import type { ThemeApi } from '../theme/useTheme';
import { AccountButton } from './AccountButton';
import { useApp } from '../state/AppProvider';

interface Props {
  sessionLabel: string;
  theme: ThemeApi;
  compact?: boolean;
  signedIn: boolean;
  connecting?: boolean;
  userName?: string;
  onConnect: () => void;
  onDisconnect: () => void;
}

export function MenuBar({
  sessionLabel,
  theme,
  compact,
  signedIn,
  connecting,
  userName,
  onConnect,
  onDisconnect,
}: Props) {
  const { openConnectionManager, openSettings, canSync, openSync } = useApp();
  return (
    <div className="flex items-center gap-3 px-3 h-9 bg-surface border-b border-border select-none">
      <span className="font-semibold">WinSCP Web</span>
      {!compact && <span className="text-muted">Session: {sessionLabel}</span>}
      <div className="ml-auto flex items-center gap-1">
        <AccountButton
          signedIn={signedIn}
          connecting={connecting}
          userName={userName}
          onConnect={onConnect}
          onDisconnect={onDisconnect}
        />
        {canSync && (
          <button
            className="h-7 px-2 rounded hover:bg-black/5 dark:hover:bg-white/10 text-text text-[13px]"
            title="Synchronize the two folders"
            onClick={openSync}
          >
            Synchronize
          </button>
        )}
        <button
          className="h-7 px-2 rounded hover:bg-black/5 dark:hover:bg-white/10 text-text text-[13px]"
          title="Saved connections"
          onClick={openConnectionManager}
        >
          Connections
        </button>
        <button
          className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/10 text-text"
          title="Settings"
          onClick={openSettings}
        >
          <IconGear />
        </button>
        <button
          className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/10 text-text"
          title="Toggle light/dark"
          onClick={theme.toggle}
        >
          {theme.theme === 'dark' ? <IconSun /> : <IconMoon />}
        </button>
      </div>
    </div>
  );
}
