import { IconMoon, IconSun } from './icons';
import type { ThemeApi } from '../theme/useTheme';
import { AccountButton } from './AccountButton';

interface Props {
  sessionLabel: string;
  theme: ThemeApi;
  compact?: boolean;
  signedIn: boolean;
  userName?: string;
  onConnect: () => void;
  onDisconnect: () => void;
}

export function MenuBar({ sessionLabel, theme, compact, signedIn, userName, onConnect, onDisconnect }: Props) {
  return (
    <div className="flex items-center gap-3 px-3 h-9 bg-surface border-b border-border select-none">
      <span className="font-semibold">WinSCP Web</span>
      {!compact && <span className="text-muted">Session: {sessionLabel}</span>}
      <div className="ml-auto flex items-center gap-1">
        <AccountButton signedIn={signedIn} userName={userName} onConnect={onConnect} onDisconnect={onDisconnect} />
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
