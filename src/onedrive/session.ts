// Coordinator that owns the OneDrive session as a single source of truth and
// makes clearing and connecting safe against races. It is dependency-injected
// (provider + recovery store) so it can be unit-tested without the SDK.
//
// Guarantees:
//  - clearSession() is serialized (duplicate clears share one in-flight op),
//    invalidates in-flight acquires (generation bump), clears the in-memory
//    token, calls the host clear via the provider, records success/failure,
//    leaves the session in `sign_in_required` (success) or `clear_failed`
//    (failure), returns a boolean, and NEVER starts OAuth.
//  - acquire() refuses while a clear is in flight or after a failed clear, and
//    only commits its result if it was not superseded by a newer clear
//    (generation) or a newer acquire (sequence).
import type { OneDriveTokenResult } from '../sdk/client';

export type SessionState =
  | 'sign_in_required'
  | 'signed_in'
  | 'clearing'
  | 'clear_failed';

export type AcquireOutcome =
  | { ok: true; token: string }
  | {
      ok: false;
      reason:
        | 'no_host'
        | 'no_token'
        | 'timeout'
        | 'error'
        | 'blocked'
        | 'superseded';
      detail?: string;
    };

export interface SessionProvider {
  /** Acquire a token from the host. Must never throw (returns a result). */
  acquire(interactive: boolean): Promise<OneDriveTokenResult>;
  /** Clear the host session. Returns true on success; must never throw. */
  clear(): Promise<boolean>;
}

/** Durable, NON-token recovery flag (survives reload). */
export interface RecoveryStore {
  getClearRequired(): boolean;
  setClearRequired(v: boolean): void;
}

export class OneDriveSession {
  private token: string | null = null;
  private generation = 0;
  private acquireSeq = 0;
  private clearing: Promise<boolean> | null = null;
  private stateValue: SessionState;

  constructor(
    private readonly provider: SessionProvider,
    private readonly store?: RecoveryStore,
  ) {
    // A clear that never finished before a reload leaves us in clear_failed so
    // the user must complete the reset before connecting again.
    this.stateValue = store?.getClearRequired() ? 'clear_failed' : 'sign_in_required';
  }

  get state(): SessionState {
    return this.stateValue;
  }
  get isClearing(): boolean {
    return this.clearing !== null;
  }
  clearRequired(): boolean {
    return this.stateValue === 'clear_failed';
  }
  isSignedIn(): boolean {
    return this.token !== null;
  }
  getToken(): string | null {
    return this.token;
  }

  /**
   * Acquire a token (silent or interactive). Guarded so it cannot commit a
   * stale result over a newer login or a reset.
   */
  async acquire(interactive: boolean): Promise<AcquireOutcome> {
    if (this.clearing) {
      return { ok: false, reason: 'blocked', detail: 'A session clear is in progress.' };
    }
    if (this.stateValue === 'clear_failed') {
      return {
        ok: false,
        reason: 'blocked',
        detail: 'Previous session clear did not complete. Clear the session first.',
      };
    }
    // Silent reuse of a live token needs no host round-trip.
    if (!interactive && this.token) return { ok: true, token: this.token };

    const gen = this.generation;
    const seq = ++this.acquireSeq;

    const res = await this.provider.acquire(interactive);

    // Superseded by a clear (generation) or a newer acquire (sequence).
    if (gen !== this.generation || seq !== this.acquireSeq) {
      return {
        ok: false,
        reason: 'superseded',
        detail: 'Superseded by a newer sign-in or a session reset.',
      };
    }

    if (res.ok) {
      this.token = res.token;
      this.stateValue = 'signed_in';
      return { ok: true, token: res.token };
    }
    // Failures are non-destructive: never drop an existing valid token here.
    return res;
  }

  /**
   * Coordinator-owned reset. Serialized, invalidates in-flight acquires, clears
   * local token + host session, records durable recovery state, returns success.
   * Never starts OAuth.
   */
  clearSession(): Promise<boolean> {
    if (this.clearing) return this.clearing; // serialize duplicate clears

    this.generation += 1; // invalidate any in-flight acquire commit
    this.token = null; // drop the local token immediately
    this.stateValue = 'clearing';

    this.clearing = (async () => {
      let ok = false;
      try {
        ok = await this.provider.clear();
      } finally {
        this.clearing = null;
        if (ok) {
          this.stateValue = 'sign_in_required';
          this.store?.setClearRequired(false);
        } else {
          this.stateValue = 'clear_failed';
          this.store?.setClearRequired(true);
        }
      }
      return ok;
    })();

    return this.clearing;
  }
}
