import { useCallback, useEffect, useState } from 'react';
import { loadTheme, saveTheme, systemTheme, type Theme } from './theme';

export interface ThemeApi {
  theme: Theme;
  toggle: () => void;
  set: (t: Theme) => void;
}

export function useTheme(): ThemeApi {
  const [theme, setThemeState] = useState<Theme>(() => loadTheme(systemTheme()));

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const set = useCallback((t: Theme) => {
    setThemeState(t);
    saveTheme(t);
  }, []);

  const toggle = useCallback(() => {
    setThemeState((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      saveTheme(next);
      return next;
    });
  }, []);

  return { theme, toggle, set };
}
