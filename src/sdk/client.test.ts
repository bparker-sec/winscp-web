import { describe, it, expect, vi, afterEach } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('ai-publish-sdk');
});

function mockSdk(over: Record<string, unknown>) {
  vi.doMock('ai-publish-sdk', () => ({
    getUserInfo: vi.fn(),
    getToken: vi.fn(),
    clearToken: vi.fn(),
    getBrandingAssets: vi.fn(),
    trackEvent: vi.fn(),
    withTimeout: (fn: () => Promise<unknown>) => fn(),
    ...over,
  }));
}

describe('sdk client', () => {
  it("getToken uses the 'onedrive' integration and returns the token", async () => {
    const getToken = vi.fn().mockResolvedValue({ token: 'T' });
    mockSdk({ getToken });
    const { sdkGetOneDriveTokenResult } = await import('./client');
    const res = await sdkGetOneDriveTokenResult(true);
    expect(res).toEqual({ ok: true, token: 'T' });
    expect(getToken).toHaveBeenCalledWith('onedrive', { interactive: true });
  });

  it('reports no_token when the host returns nothing', async () => {
    mockSdk({ getToken: vi.fn().mockResolvedValue(null) });
    const { sdkGetOneDriveTokenResult } = await import('./client');
    expect(await sdkGetOneDriveTokenResult(false)).toEqual({ ok: false, reason: 'no_token' });
  });

  it('maps a thrown error and never throws', async () => {
    mockSdk({ getToken: vi.fn().mockRejectedValue(new Error('boom')) });
    const { sdkGetOneDriveTokenResult } = await import('./client');
    const res = await sdkGetOneDriveTokenResult(true);
    expect(res.ok).toBe(false);
  });

  it("sdkClearOneDriveResult calls clearToken('onedrive') and returns true", async () => {
    const clearToken = vi.fn().mockResolvedValue(undefined);
    mockSdk({ clearToken });
    const { sdkClearOneDriveResult } = await import('./client');
    await expect(sdkClearOneDriveResult()).resolves.toBe(true);
    expect(clearToken).toHaveBeenCalledWith('onedrive');
  });

  it('sdkClearOneDriveResult returns false when the host clear fails', async () => {
    mockSdk({ clearToken: vi.fn().mockRejectedValue(new Error('x')) });
    const { sdkClearOneDriveResult } = await import('./client');
    await expect(sdkClearOneDriveResult()).resolves.toBe(false);
  });

  it('sdkProbeHost is false when getUserInfo throws', async () => {
    mockSdk({ getUserInfo: vi.fn().mockRejectedValue(new Error('no host')) });
    const { sdkProbeHost } = await import('./client');
    expect(await sdkProbeHost()).toBe(false);
  });

  it('sdkGetUser returns null when getUserInfo throws', async () => {
    mockSdk({ getUserInfo: vi.fn().mockRejectedValue(new Error('no host')) });
    const { sdkGetUser } = await import('./client');
    expect(await sdkGetUser()).toBeNull();
  });

  it('sdkGetBranding returns null when getBrandingAssets throws', async () => {
    mockSdk({ getBrandingAssets: vi.fn().mockRejectedValue(new Error('x')) });
    const { sdkGetBranding } = await import('./client');
    expect(await sdkGetBranding()).toBeNull();
  });

  it("classifies a timeout error as reason 'timeout'", async () => {
    mockSdk({ getToken: vi.fn().mockRejectedValue(new Error('RPC timeout: getToken')) });
    const { sdkGetOneDriveTokenResult } = await import('./client');
    expect(await sdkGetOneDriveTokenResult(false)).toMatchObject({ ok: false, reason: 'timeout' });
  });

  it("classifies a generic error as reason 'error'", async () => {
    mockSdk({ getToken: vi.fn().mockRejectedValue(new Error('boom')) });
    const { sdkGetOneDriveTokenResult } = await import('./client');
    expect(await sdkGetOneDriveTokenResult(false)).toMatchObject({ ok: false, reason: 'error' });
  });

  it('sdkTrack swallows a synchronous throw', async () => {
    mockSdk({ trackEvent: vi.fn(() => { throw new Error('sync'); }) });
    const { sdkTrack } = await import('./client');
    expect(() => sdkTrack('evt')).not.toThrow();
  });

  it('sdkTrack swallows an async rejection', async () => {
    mockSdk({ trackEvent: vi.fn().mockRejectedValue(new Error('async')) });
    const { sdkTrack } = await import('./client');
    expect(() => sdkTrack('evt')).not.toThrow();
    await Promise.resolve();
  });
});
