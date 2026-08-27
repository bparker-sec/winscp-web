import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadTheme, saveTheme, THEME_KEY, type Theme } from './theme';

describe('theme persistence', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips a saved theme', () => {
    saveTheme('dark');
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
    expect(loadTheme('light')).toBe('dark');
  });

  it('falls back to the provided system default when nothing is saved', () => {
    expect(loadTheme('dark')).toBe('dark');
    expect(loadTheme('light')).toBe('light');
  });

  it('ignores a corrupt stored value', () => {
    localStorage.setItem(THEME_KEY, 'chartreuse');
    expect(loadTheme('light')).toBe('light');
  });

  it('does not throw if localStorage is unavailable', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => saveTheme('dark' as Theme)).not.toThrow();
    spy.mockRestore();
  });
});
