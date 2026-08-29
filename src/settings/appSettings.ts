// A tiny persisted app-settings store, backed by localStorage. Kept
// deliberately small: one JSON blob under a single key, safe-parsed with
// defaults on missing/corrupt storage.

export interface AppSettings {
  /** Minutes of inactivity before the vault auto-locks. 0 = never auto-lock. */
  vaultLockMinutes: number;
  /**
   * How many transfer requests are kept in flight at once per file (pipeline
   * depth). 1 = the old one-at-a-time behavior; higher fills the link so a
   * high-latency (WAN) connection isn't stalled waiting for each acknowledgement.
   */
  pipelineDepth: number;
  /**
   * SSH channel receive-window size, in MiB. This is how much data the server is
   * allowed to send us (downloads) before pausing for an acknowledgement; a
   * larger window keeps a fast/high-latency link saturated. Uploads are governed
   * by the server's own window and are unaffected.
   */
  transferWindowMB: number;
}

/** Allowed range for pipeline depth (UI offers discrete steps within this). */
export const PIPELINE_DEPTH_MIN = 1;
export const PIPELINE_DEPTH_MAX = 64;
/** Allowed range for the transfer window, in MiB. */
export const TRANSFER_WINDOW_MIN_MB = 1;
export const TRANSFER_WINDOW_MAX_MB = 32;

// Defaults are tuned for maximum throughput out of the box: a deep pipeline plus
// a large window keep even a high-latency link busy. Users on constrained or
// flaky connections can dial both down.
export const DEFAULT_SETTINGS: AppSettings = {
  vaultLockMinutes: 15,
  pipelineDepth: PIPELINE_DEPTH_MAX,
  transferWindowMB: 16,
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

/** Clamp `v` into [min, max], rounding to an integer; falls back to `fallback`. */
function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
}

/** Coerce an arbitrary parsed blob into a fully-valid AppSettings. */
function sanitize(v: unknown): AppSettings {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const vaultLockMinutes =
    typeof o.vaultLockMinutes === 'number' && Number.isFinite(o.vaultLockMinutes) && o.vaultLockMinutes >= 0
      ? o.vaultLockMinutes
      : DEFAULT_SETTINGS.vaultLockMinutes;
  return {
    vaultLockMinutes,
    pipelineDepth: clampInt(o.pipelineDepth, PIPELINE_DEPTH_MIN, PIPELINE_DEPTH_MAX, DEFAULT_SETTINGS.pipelineDepth),
    transferWindowMB: clampInt(
      o.transferWindowMB,
      TRANSFER_WINDOW_MIN_MB,
      TRANSFER_WINDOW_MAX_MB,
      DEFAULT_SETTINGS.transferWindowMB,
    ),
  };
}

export function getSettings(): AppSettings {
  const s = storage();
  if (!s) return { ...DEFAULT_SETTINGS };
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return sanitize(JSON.parse(raw));
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
