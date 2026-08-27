export type Theme = 'light' | 'dark';

export const THEME_KEY = 'winscp-theme';

/** The OS/browser preference, defaulting to light when unknown. */
export function systemTheme(): Theme {
  try {
    // try/catch guards SSR / non-browser eval where `window` is undefined.
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** Load the saved theme, falling back to `fallback` when absent/corrupt. */
export function loadTheme(fallback: Theme): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : fallback;
  } catch {
    return fallback;
  }
}

/** Persist the theme choice; never throws. */
export function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* ignore */
  }
}
