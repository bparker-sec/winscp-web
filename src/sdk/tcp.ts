// Crash-safe wrapper over the ai-publish-sdk TCP proxy. The host relays raw TCP
// (SFTP/SSH) since a browser cannot open sockets directly. All data is base64.
import { tcp, type TcpSocket } from 'ai-publish-sdk';
import type { RawSocket } from '../net/ByteStream';

export type { TcpSocket };

export interface TcpConnectResult {
  ok: boolean;
  socket?: RawSocket;
  detail?: string;
}

/** Open a TCP connection through the host. Returns a RawSocket or a reason. */
export async function tcpConnect(host: string, port: number): Promise<TcpConnectResult> {
  try {
    const sock = await tcp.connect(host, port);
    if (!sock) return { ok: false, detail: 'TCP is unavailable in this host.' };
    return { ok: true, socket: sock };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
