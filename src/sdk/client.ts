// Crash-safe wrappers around ai-publish-sdk. Every host interaction goes through
// here; each wrapper degrades to a safe fallback if the SDK/host is unavailable
// (e.g. when the built app is opened outside a host during review).
import {
  getUserInfo,
  getToken,
  clearToken,
  getBrandingAssets,
  trackEvent,
  withTimeout,
  type UserInfo,
  type BrandingAssets,
  type TrackEventDetails,
  type TrackEventParams,
} from 'ai-publish-sdk';

export type { UserInfo, BrandingAssets };

const ONEDRIVE = 'onedrive';
const INTERACTIVE_TIMEOUT_MS = 120_000;
const HOST_PROBE_TIMEOUT_MS = 4_000;
const SILENT_TIMEOUT_MS = 8_000;

/** True when a host is actually answering RPC (probed, not inferred from frames). */
export async function sdkProbeHost(): Promise<boolean> {
  try {
    await withTimeout(() => getUserInfo(), HOST_PROBE_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
}

export async function sdkGetUser(): Promise<UserInfo | null> {
  try {
    return await withTimeout(() => getUserInfo(), HOST_PROBE_TIMEOUT_MS);
  } catch {
    return null;
  }
}

export type OneDriveTokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'no_token' | 'timeout' | 'error'; detail?: string };

/** Acquire a OneDrive OAuth token via the host, reporting WHY it failed. */
export async function sdkGetOneDriveTokenResult(
  interactive: boolean,
): Promise<OneDriveTokenResult> {
  try {
    const call = () => getToken(ONEDRIVE, { interactive });
    const res = interactive
      ? await withTimeout(call, INTERACTIVE_TIMEOUT_MS)
      : await withTimeout(call, SILENT_TIMEOUT_MS);
    if (res?.token) return { ok: true, token: res.token };
    return { ok: false, reason: 'no_token' };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    // Heuristic: the SDK exposes no typed error; it surfaces RPC timeouts as a message containing "timeout".
    return { ok: false, reason: /timeout/i.test(detail) ? 'timeout' : 'error', detail };
  }
}

/** Clear the host-managed OneDrive session. Returns true only on confirmed clear. */
export async function sdkClearOneDriveResult(): Promise<boolean> {
  try {
    await withTimeout(() => clearToken(ONEDRIVE), SILENT_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
}

export async function sdkGetBranding(): Promise<BrandingAssets | null> {
  try {
    return await withTimeout(() => getBrandingAssets(), HOST_PROBE_TIMEOUT_MS);
  } catch {
    return null;
  }
}

/** Fire-and-forget analytics. Never throws (or rejects) into the UI. */
export function sdkTrack(eventName: string, additionalDetails?: TrackEventDetails): void {
  try {
    const params = { eventName, additionalDetails } as unknown as TrackEventParams;
    Promise.resolve(trackEvent(params)).catch(() => {});
  } catch {
    /* ignore */
  }
}
