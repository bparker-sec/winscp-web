// A tiny persisted app-settings store, backed by localStorage. Kept
// deliberately small: one JSON blob under a single key, safe-parsed with
// defaults on missing/corrupt storage.

export interface AppSettings {
  /** Minutes of inactivity before the vault auto-locks. 0 = never auto-lock. */
  vaultLockMinutes: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  vaultLockMinutes: 15,
};

const STORAGE_KEY = 'winscp-settings';

/** Minimal storage shape we depend on -- lets tests inject an in-memory stand-in. */
export interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function safeLocalStorage(): SettingsStorage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

let storageOverride: SettingsStorage | null = null;

/** Test-only hook: inject an in-memory storage so tests don't touch real localStorage. */
export function _setStorageForTests(storage: SettingsStorage | null): void {
  storageOverride = storage;
}

function storage(): SettingsStorage | null {
  return storageOverride ?? safeLocalStorage();
}

function isValidSettings(v: unknown): v is AppSettings {
  if (!v || typeof v !== 'object') return false;
  const n = (v as Record<string, unknown>).vaultLockMinutes;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

export function getSettings(): AppSettings {
  const s = storage();
  if (!s) return { ...DEFAULT_SETTINGS };
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    if (!isValidSettings(parsed)) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function setSettings(partial: Partial<AppSettings>): void {
  const merged = { ...getSettings(), ...partial };
  const s = storage();
  if (!s) return;
  try {
    s.setItem(STORAGE_KEY, JSON.stringify(merged));
  } catch {
    // Storage can throw (quota, privacy mode) -- settings just won't persist.
  }
}
