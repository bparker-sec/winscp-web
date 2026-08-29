import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getSettings,
  setSettings,
  DEFAULT_SETTINGS,
  _setStorageForTests,
  type SettingsStorage,
} from './appSettings';

function makeMemoryStorage(): SettingsStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

describe('appSettings', () => {
  beforeEach(() => {
    _setStorageForTests(makeMemoryStorage());
  });

  afterEach(() => {
    _setStorageForTests(null);
  });

  it('returns defaults when nothing is stored', () => {
    expect(getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('round-trips a set value', () => {
    setSettings({ vaultLockMinutes: 30 });
    expect(getSettings()).toEqual({ ...DEFAULT_SETTINGS, vaultLockMinutes: 30 });
  });

  it('round-trips transfer-performance settings', () => {
    setSettings({ pipelineDepth: 16, transferWindowMB: 8 });
    const s = getSettings();
    expect(s.pipelineDepth).toBe(16);
    expect(s.transferWindowMB).toBe(8);
  });

  it('clamps out-of-range pipeline depth and window into their valid ranges', () => {
    setSettings({ pipelineDepth: 9999, transferWindowMB: -5 });
    const s = getSettings();
    expect(s.pipelineDepth).toBe(64); // PIPELINE_DEPTH_MAX
    expect(s.transferWindowMB).toBe(1); // TRANSFER_WINDOW_MIN_MB
  });

  it('coerces non-numeric performance values back to defaults', () => {
    const storage = makeMemoryStorage();
    storage.setItem(
      'winscp-settings',
      JSON.stringify({ vaultLockMinutes: 5, pipelineDepth: 'fast', transferWindowMB: null }),
    );
    _setStorageForTests(storage);
    const s = getSettings();
    expect(s.vaultLockMinutes).toBe(5);
    expect(s.pipelineDepth).toBe(DEFAULT_SETTINGS.pipelineDepth);
    expect(s.transferWindowMB).toBe(DEFAULT_SETTINGS.transferWindowMB);
  });

  it('merges partial updates over existing settings', () => {
    setSettings({ vaultLockMinutes: 5 });
    setSettings({});
    expect(getSettings().vaultLockMinutes).toBe(5);
  });

  it('falls back to defaults on corrupt JSON', () => {
    const storage = makeMemoryStorage();
    storage.setItem('winscp-settings', '{not valid json');
    _setStorageForTests(storage);
    expect(getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('falls back to defaults on a malformed shape', () => {
    const storage = makeMemoryStorage();
    storage.setItem('winscp-settings', JSON.stringify({ vaultLockMinutes: 'never' }));
    _setStorageForTests(storage);
    expect(getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('accepts 0 (never auto-lock) as a valid value', () => {
    setSettings({ vaultLockMinutes: 0 });
    expect(getSettings().vaultLockMinutes).toBe(0);
  });

  it('uses a fresh in-memory store per test (injectable)', () => {
    setSettings({ vaultLockMinutes: 60 });
    _setStorageForTests(makeMemoryStorage());
    expect(getSettings()).toEqual(DEFAULT_SETTINGS);
  });
});
