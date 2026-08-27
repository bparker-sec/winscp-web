import { useCallback, useEffect, useState } from 'react';
import { loadTheme, saveTheme, systemTheme, type Theme } from './theme';

export interface ThemeApi {
  theme: Theme;
  toggle: () => void;
  set: (t: Theme) => void;
}

export function useTheme(): ThemeApi {
  const [theme, setThemeState] = useState<Theme>(() => loadTheme(systemTheme()));

  // Single place for side effects: reflect the theme onto <html> and persist it
  // whenever it changes (and once on mount). Keeping persistence OUT of the state
  // updater keeps the updater pure — safe under React StrictMode.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    saveTheme(theme);
  }, [theme]);

  const set = useCallback((t: Theme) => setThemeState(t), []);
  const toggle = useCallback(
    () => setThemeState((prev) => (prev === 'dark' ? 'light' : 'dark')),
    [],
  );

  return { theme, toggle, set };
}
