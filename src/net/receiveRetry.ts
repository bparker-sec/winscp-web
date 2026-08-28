// Idle-tolerant receive wrapper. The host's receive RPC rejects with a
// "timeout" after a short idle window; a live SSH/SFTP connection is idle
// between user actions, so such a timeout is NORMAL and must NOT be treated as a
// dropped connection. This wraps a raw receive so idle timeouts are retried,
// with a backstop that still declares a genuinely silent peer dead. Kept free of
// any SDK import so both sdk/tcp (production) and the live verification harness
// can share the exact same logic.

/** ~4 silent windows before a peer is declared dead. */
export const DEFAULT_MAX_CONSECUTIVE_IDLE_TIMEOUTS = 4;

/** True for the host's idle-window rejection (as opposed to a real socket error). */
export function isIdleTimeout(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return msg.includes('timeout') || msg.includes('timed out');
}

/**
 * Wrap `receive` so consecutive idle timeouts are retried rather than surfaced
 * as a connection loss. The counter resets whenever real data (or a `null`
 * peer-closed signal) arrives; after `maxConsecutiveIdleTimeouts` empty windows
 * in a row with nothing at all, it throws to declare the peer dead. Any
 * non-timeout rejection (reset/closed) propagates immediately.
 */
export function idleTolerantReceive<T>(
  receive: () => Promise<T>,
  maxConsecutiveIdleTimeouts: number = DEFAULT_MAX_CONSECUTIVE_IDLE_TIMEOUTS,
): () => Promise<T> {
  let consecutiveIdleTimeouts = 0;
  return async () => {
    for (;;) {
      try {
        const data = await receive();
        consecutiveIdleTimeouts = 0;
        return data;
      } catch (e) {
        if (isIdleTimeout(e)) {
          consecutiveIdleTimeouts += 1;
          if (consecutiveIdleTimeouts >= maxConsecutiveIdleTimeouts) {
            throw new Error('SFTP connection timed out (peer stopped responding).');
          }
          continue; // idle window — keep waiting for the keepalive reply or data
        }
        throw e; // a real socket error (reset/closed) → propagate immediately
      }
    }
  };
}
