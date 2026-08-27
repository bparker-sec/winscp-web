// OneDrive session access. All token acquisition and clearing goes through a
// single coordinator (see session.ts) so clears reach BOTH the host (via
// clearToken) and local state, and races cannot restore a stale token.
import { sdkGetOneDriveTokenResult, sdkClearOneDriveResult } from '../sdk/client';
import type { Authable } from './graph';
import {
  OneDriveSession,
  type AcquireOutcome,
  type RecoveryStore,
  type SessionProvider,
  type SessionState,
} from './session';

// Durable, NON-token recovery flag: records that a clear did not complete, so a
// reload can require the user to finish the reset before connecting.
const CLEAR_KEY = 'winscp-onedrive-clear-required';

const recoveryStore: RecoveryStore = {
  getClearRequired() {
    try {
      return localStorage.getItem(CLEAR_KEY) === '1';
    } catch {
      return false;
    }
  },
  setClearRequired(v) {
    try {
      if (v) localStorage.setItem(CLEAR_KEY, '1');
      else localStorage.removeItem(CLEAR_KEY);
    } catch {
      /* ignore */
    }
  },
};

const provider: SessionProvider = {
  acquire: (interactive) => sdkGetOneDriveTokenResult(interactive),
  clear: () => sdkClearOneDriveResult(),
};

export const oneDriveSession = new OneDriveSession(provider, recoveryStore);

// Adapter for the Graph client. Silent (force=false) reuses the live token or
// attempts a silent acquire; force=true performs an interactive refresh.
export const oneDriveAuth: Authable = {
  async getToken(force = false): Promise<string | null> {
    const res = await oneDriveSession.acquire(!!force);
    return res.ok ? res.token : null;
  },
};

/** Startup silent validation (guarded; cannot clobber a newer login). */
export async function trySilentOneDrive(): Promise<boolean> {
  return (await oneDriveSession.acquire(false)).ok;
}

/** Explicit, interactive sign-in. Returns the guarded outcome. */
export function connectOneDrive(): Promise<AcquireOutcome> {
  return oneDriveSession.acquire(true);
}

/** Coordinator-owned reset: clears host + local session, returns success. */
export function clearOneDriveSession(): Promise<boolean> {
  return oneDriveSession.clearSession();
}

export function oneDriveState(): SessionState {
  return oneDriveSession.state;
}
export function isOneDriveSignedIn(): boolean {
  return oneDriveSession.isSignedIn();
}
