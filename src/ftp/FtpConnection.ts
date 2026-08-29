// FtpConnection: glues tcpConnect -> control ByteStream -> FTP login into a
// single FileSystem-producing entry point, mirroring SftpConnection. FTP needs
// two channels: one long-lived control connection (line-based commands over the
// control ByteStream) and a fresh passive DATA connection per transfer/listing.
//
// Only passive mode is supported: a browser (and the host TCP proxy) cannot
// accept inbound connections, so active mode is impossible. Plain FTP only;
// FTPS/TLS over the raw proxy is not implemented yet.

import { tcpConnect, type TcpConnectResult } from '../sdk/tcp';
import { ByteStream, type RawSocket } from '../net/ByteStream';

/**
 * Opens a raw TCP connection, returning a RawSocket or a reason. Defaults to the
 * host proxy's {@link tcpConnect}; injectable so the FTP control + passive-data
 * connections can be driven over a real socket in dev/live verification.
 */
export type TcpConnectFn = (host: string, port: number) => Promise<TcpConnectResult>;
import { base64Encode, base64Decode } from '../net/base64';
import { FsError, type FileSystem } from '../fs/FileSystem';
import {
  parseReplyLine,
  parseEpsv,
  parsePasv,
  parsePwd,
  resolveDataHost,
  type FtpReply,
} from './parse';
import { FtpFS } from './FtpFS';

export interface FtpCredentials {
  host: string;
  port: number;
  username: string;
  password: string;
  secure?: boolean;
}

export interface FtpConnection {
  fs: FileSystem;
  home: string;
  close(): Promise<void>;
}

function concat(a: Uint8Array, b: Uint8Array) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Map an FTP reply code to an FsError. The optional `path` sharpens the message.
 * 530 -> permission, 550 -> not-found (default; callers disambiguate 'exists'),
 * 552 -> io (quota/allocation), everything else in the failure range -> io.
 */
export function ftpError(reply: FtpReply, context?: string): FsError {
  const detail = context ? `${context}: ${reply.text}` : reply.text;
  switch (reply.code) {
    case 530:
    case 532:
      return new FsError('permission', detail);
    case 550:
      // 550 is overloaded: "no such file", "permission denied", "not a
      // directory". Default to not-found; callers with better context override.
      return new FsError('not-found', detail);
    case 552:
      return new FsError('io', detail);
    default:
      return new FsError('io', `FTP ${reply.code}: ${detail}`);
  }
}

/** A binary data connection (passive). Reads decode from base64; EOF is a null receive. */
export class FtpDataConnection {
  private buf = new Uint8Array(0);
  private eof = false;

  constructor(private readonly sock: RawSocket) {}

  /** Pull up to `into.byteLength` bytes; returns bytes copied, or 0 at EOF. */
  async read(into: Uint8Array): Promise<number> {
    while (this.buf.length === 0 && !this.eof) {
      const chunkB64 = await this.sock.receive();
      if (chunkB64 === null) {
        this.eof = true;
        break;
      }
      const chunk = base64Decode(chunkB64);
      if (chunk.length > 0) this.buf = concat(this.buf, chunk);
    }
    if (this.buf.length === 0) return 0;
    const n = Math.min(this.buf.length, into.byteLength);
    into.set(this.buf.subarray(0, n));
    this.buf = this.buf.slice(n);
    return n;
  }

  /** Drain the whole connection to a single buffer (used for LIST/MLSD). */
  async readAll(): Promise<Uint8Array> {
    for (;;) {
      const chunkB64 = await this.sock.receive();
      if (chunkB64 === null) break;
      const chunk = base64Decode(chunkB64);
      if (chunk.length > 0) this.buf = concat(this.buf, chunk);
    }
    const out = this.buf;
    this.buf = new Uint8Array(0);
    this.eof = true;
    return out;
  }

  async write(bytes: Uint8Array): Promise<void> {
    const n = await this.sock.send(base64Encode(bytes));
    if (n === null) throw new FsError('io', 'FTP data send failed (socket unavailable).');
  }

  async close(): Promise<void> {
    await this.sock.close();
  }
}

/**
 * The FTP control client. Owns the control ByteStream, serializes all access
 * through a single mutex (FTP is one-command-at-a-time and one-transfer-at-a-time
 * on a single connection), and opens passive data connections on demand.
 */
export class FtpClient {
  private lock: Promise<void> = Promise.resolve();

  constructor(
    private readonly control: ByteStream,
    readonly host: string,
    private readonly controlSock: RawSocket,
    /** Connector for passive DATA connections (defaults to the host proxy). */
    private readonly dataConnect: TcpConnectFn = tcpConnect,
  ) {}

  /** Run `fn` with exclusive use of the control (and data) channel. */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Manually acquire the lock, returning a release function. Used by openRead/
   * openWrite which must hold the channel across the returned handle's lifetime
   * (until close()/abort()).
   */
  async acquire(): Promise<() => void> {
    const prev = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((r) => (release = r));
    await prev;
    return release;
  }

  /** Read one (possibly multiline) reply from the control stream. */
  async readReply(): Promise<FtpReply> {
    const first = await this.control.readLine(4096);
    const parsed = parseReplyLine(first);
    if (parsed.code === null) {
      throw new FsError('io', `Malformed FTP reply: ${JSON.stringify(first)}`);
    }
    const code = parsed.code;
    const lines = [parsed.text];
    if (parsed.sep === ' ') return { code, text: parsed.text, lines };
    // Multiline: read until `NNN<space>...` with the same code.
    for (;;) {
      const line = await this.control.readLine(4096);
      const p = parseReplyLine(line);
      if (p.code === code && p.sep === ' ') {
        lines.push(p.text);
        return { code, text: lines.join('\n'), lines };
      }
      lines.push(line.replace(/^\d{3}-/, ''));
    }
  }

  /** Write `line + CRLF` to the control channel. */
  private async writeLine(line: string): Promise<void> {
    await this.control.write(new TextEncoder().encode(`${line}\r\n`));
  }

  /** Send a command and read its reply. Caller must hold the lock. */
  async command(line: string): Promise<FtpReply> {
    await this.writeLine(line);
    return this.readReply();
  }

  /** Send a command; throw ftpError unless the reply code is in `expected`. */
  async commandExpect(line: string, expected: number[], context?: string): Promise<FtpReply> {
    const reply = await this.command(line);
    if (!expected.includes(reply.code)) throw ftpError(reply, context ?? line.split(' ')[0]);
    return reply;
  }

  /**
   * Open a passive data connection. Prefers EPSV (data host = control host),
   * falling back to PASV (parsed IP, or control host when that IP is private).
   * Caller must hold the lock.
   */
  async openPassive(): Promise<FtpDataConnection> {
    let host = this.host;
    let port: number;
    const epsv = await this.command('EPSV');
    if (epsv.code === 229) {
      port = parseEpsv(epsv.text);
    } else {
      const pasv = await this.command('PASV');
      if (pasv.code !== 227) throw ftpError(pasv, 'PASV');
      const parsed = parsePasv(pasv.text);
      host = resolveDataHost(this.host, parsed.host);
      port = parsed.port;
    }
    const result = await this.dataConnect(host, port);
    if (!result.ok || !result.socket) {
      throw new FsError('io', `Failed to open FTP data connection to ${host}:${port}: ${result.detail ?? 'unknown error'}`);
    }
    return new FtpDataConnection(result.socket);
  }

  /** Send QUIT (best-effort) and close the control socket. */
  async quit(): Promise<void> {
    try {
      await this.withLock(async () => {
        await this.writeLine('QUIT');
        // Read the 221 goodbye if it comes; ignore anything odd.
        await this.readReply().catch(() => undefined);
      });
    } catch {
      // ignore — we're tearing down anyway
    }
    await this.controlSock.close().catch(() => undefined);
  }
}

/**
 * Connect to an FTP server end-to-end: TCP (via the host proxy) -> read greeting
 * -> USER/PASS -> TYPE I -> best-effort UTF8 -> PWD (home). Returns a ready
 * FileSystem.
 */
export async function connectFtp(
  creds: FtpCredentials,
  label?: string,
  opts?: { tcpConnect?: TcpConnectFn },
): Promise<FtpConnection> {
  const { host, port, username, password } = creds;
  const connect = opts?.tcpConnect ?? tcpConnect;

  if (creds.secure) {
    throw new FsError('unsupported', 'FTPS/TLS is not yet supported (plain FTP only).');
  }

  const tcpResult = await connect(host, port);
  if (!tcpResult.ok || !tcpResult.socket) {
    throw new FsError('io', `Failed to connect to ${host}:${port}: ${tcpResult.detail ?? 'unknown error'}`);
  }

  const stream = new ByteStream(tcpResult.socket);
  const client = new FtpClient(stream, host, tcpResult.socket, connect);

  const home = await client.withLock(async () => {
    // Greeting (220). Some servers emit a multiline banner; readReply folds it.
    const greeting = await client.readReply();
    if (greeting.code !== 220) throw ftpError(greeting, 'FTP greeting');

    const userReply = await client.command(`USER ${username}`);
    if (userReply.code === 331 || userReply.code === 332) {
      const passReply = await client.command(`PASS ${password}`);
      if (passReply.code !== 230 && passReply.code !== 202) throw ftpError(passReply, 'PASS');
    } else if (userReply.code !== 230) {
      throw ftpError(userReply, 'USER');
    }

    // Binary type (required for correct byte-accurate transfers).
    await client.commandExpect('TYPE I', [200], 'TYPE I');

    // Best-effort UTF-8; ignore servers that don't support it.
    await client.command('OPTS UTF8 ON').catch(() => undefined);

    const pwd = await client.command('PWD');
    if (pwd.code === 257) {
      return parsePwd(pwd.text) ?? '/';
    }
    return '/';
  });

  const fs = new FtpFS(client, label ?? `${username}@${host}`);

  return {
    fs,
    home,
    close: () => client.quit(),
  };
}
