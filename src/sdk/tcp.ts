// Crash-safe wrapper over the ai-publish-sdk TCP proxy. The host relays raw TCP
// (SFTP/SSH) since a browser cannot open sockets directly. All data is base64.
import { tcp, withTimeout, type TcpSocket } from 'ai-publish-sdk';
import type { RawSocket } from '../net/ByteStream';

export type { TcpSocket };

export interface TcpConnectResult {
  ok: boolean;
  socket?: RawSocket;
  detail?: string;
}

// A live SSH/FTP connection sits idle between user actions, so a receive must be
// allowed to wait far longer than the SDK's default (~15s) RPC timeout —
// otherwise the read loop mistakes idle for a dropped connection and tears the
// session down. SshClient sends a keepalive every 25s, so real traffic always
// arrives well within this window; only a genuinely dead peer hits it.
const RECEIVE_TIMEOUT_MS = 120_000;

/** Open a TCP connection through the host. Returns a RawSocket or a reason. */
export async function tcpConnect(host: string, port: number): Promise<TcpConnectResult> {
  try {
    const sock = await tcp.connect(host, port);
    if (!sock) return { ok: false, detail: 'TCP is unavailable in this host.' };
    // Wrap the socket so receives get a long RPC timeout (idle-tolerant); send
    // and close keep the SDK default.
    const socket: RawSocket = {
      send: (dataBase64: string) => sock.send(dataBase64),
      receive: () => withTimeout(() => sock.receive(), RECEIVE_TIMEOUT_MS),
      close: () => sock.close(),
    };
    return { ok: true, socket };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
