// Crash-safe wrapper over the ai-publish-sdk TCP proxy. The host relays raw TCP
// (SFTP/SSH) since a browser cannot open sockets directly. All data is base64.
import { tcp, withTimeout, type TcpSocket } from 'ai-publish-sdk';
import type { RawSocket } from '../net/ByteStream';
import { idleTolerantReceive } from '../net/receiveRetry';

export type { TcpSocket };

export interface TcpConnectResult {
  ok: boolean;
  socket?: RawSocket;
  detail?: string;
}

// Per-attempt hang-guard: bounds a single underlying receive that never settles.
// The host's own receive RPC normally rejects with a "timeout" well before this
// on an idle window; that idle rejection is tolerated by idleTolerantReceive
// (retried, not treated as a dropped connection) with a backstop that still
// detects a genuinely silent peer. See net/receiveRetry.
const RECEIVE_ATTEMPT_TIMEOUT_MS = 30_000;

/** Open a TCP connection through the host. Returns a RawSocket or a reason. */
export async function tcpConnect(host: string, port: number): Promise<TcpConnectResult> {
  try {
    const sock = await tcp.connect(host, port);
    if (!sock) return { ok: false, detail: 'TCP is unavailable in this host.' };
    const socket: RawSocket = {
      send: (dataBase64: string) => sock.send(dataBase64),
      receive: idleTolerantReceive(() => withTimeout(() => sock.receive(), RECEIVE_ATTEMPT_TIMEOUT_MS)),
      close: () => sock.close(),
    };
    return { ok: true, socket };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
