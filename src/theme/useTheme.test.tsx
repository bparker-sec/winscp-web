import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTheme } from './useTheme';
import { THEME_KEY } from './theme';

describe('useTheme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('applies the stored theme to <html> on mount', () => {
    localStorage.setItem(THEME_KEY, 'dark');
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('toggle flips state, updates the attribute, and persists', () => {
    localStorage.setItem(THEME_KEY, 'light');
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('light');
    act(() => result.current.toggle());
    expect(result.current.theme).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
  });

  it('set persists the chosen theme', () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.set('dark'));
    expect(result.current.theme).toBe('dark');
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
  });
});
