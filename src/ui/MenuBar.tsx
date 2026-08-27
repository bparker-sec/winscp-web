import { IconMoon, IconSun } from './icons';
import type { ThemeApi } from '../theme/useTheme';

interface Props {
  sessionLabel: string;
  theme: ThemeApi;
  compact?: boolean;
}

export function MenuBar({ sessionLabel, theme, compact }: Props) {
  return (
    <div className="flex items-center gap-3 px-3 h-9 bg-surface border-b border-border select-none">
      <span className="font-semibold">WinSCP Web</span>
      {!compact && <span className="text-muted">Session: {sessionLabel}</span>}
      <button
        className="ml-auto p-1 rounded hover:bg-black/5 dark:hover:bg-white/10 text-text"
        title="Toggle light/dark"
        onClick={theme.toggle}
      >
        {theme.theme === 'dark' ? <IconSun /> : <IconMoon />}
      </button>
    </div>
  );
}
