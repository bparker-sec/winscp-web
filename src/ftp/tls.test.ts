import { describe, it, expect, beforeAll, beforeEach, vi, type Mock } from 'vitest';
import forge from 'node-forge';

import { base64Encode, base64Decode } from '../net/base64';
import type { RawSocket } from '../net/ByteStream';

// The real TLS module is fetched via importActual for the wrapper tests; the
// static './tls' import is mocked so connectFtp's upgradeToTls call can be
// stubbed with a scripted post-handshake control channel in the sequencing
// tests. (vi.mock replaces the whole module, so the genuine implementation is
// only reachable through importActual.)
vi.mock('./tls', () => ({ upgradeToTls: vi.fn() }));
// Avoid loading the real ai-publish-sdk (host proxy) under jsdom.
vi.mock('../sdk/tcp', () => ({ tcpConnect: vi.fn() }));

import { upgradeToTls } from './tls';
import { connectFtp } from './FtpConnection';

type TlsModule = typeof import('./tls');
let tls: TlsModule;

// A self-signed cert/key reused by every TLS wrapper test (RSA keygen is slow).
let certPem: string;
let keyPem: string;

beforeAll(async () => {
  tls = await vi.importActual<TlsModule>('./tls');

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 24 * 3600 * 1000);
  const attrs = [{ name: 'commonName', value: 'test.local' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey);
  certPem = forge.pki.certificateToPem(cert);
  keyPem = forge.pki.privateKeyToPem(keys.privateKey);
}, 30_000);

// ---------------------------------------------------------------------------
// A tiny async queue: take() resolves as soon as a value is available.
// ---------------------------------------------------------------------------
class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: ((v: T) => void)[] = [];
  push(v: T): void {
    const w = this.waiters.shift();
    if (w) w(v);
    else this.items.push(v);
  }
  take(): Promise<T> {
    if (this.items.length) return Promise.resolve(this.items.shift()!);
    return new Promise<T>((resolve) => this.waiters.push(resolve));
  }
}

/**
 * Build a forge TLS *server* and an in-memory RawSocket that shuttles bytes
 * between it and an upgradeToTls *client*. Returns the client-facing inner
 * socket, plus handles to drive/inspect the server side.
 */
function makeServerPipe() {
  const toClient = new AsyncQueue<string | null>(); // base64 chunks / null EOF -> client
  const appReceived: Uint8Array[] = []; // plaintext the server decrypted
  let serverError: Error | null = null;
  let serverConnected = false;

  const server = forge.tls.createConnection({
    server: true,
    getCertificate: () => certPem,
    getPrivateKey: () => keyPem,
    connected: () => {
      serverConnected = true;
    },
    tlsDataReady: (c) => {
      const bytes = c.tlsData.getBytes();
      if (bytes.length > 0) toClient.push(base64Encode(tls.binaryStringToBytes(bytes)));
    },
    dataReady: (c) => {
      const bytes = c.data.getBytes();
      if (bytes.length > 0) appReceived.push(tls.binaryStringToBytes(bytes));
    },
    closed: () => {
      toClient.push(null);
    },
    error: (_c, e) => {
      serverError = e as unknown as Error;
    },
  });

  // The client's transport: sending feeds the server; receiving reads whatever
  // ciphertext the server has produced.
  const innerForClient: RawSocket = {
    async send(dataB64: string) {
      server.process(tls.bytesToBinaryString(base64Decode(dataB64)));
      if (serverError) throw serverError;
      return dataB64.length;
    },
    receive: () => toClient.take(),
    async close() {
      server.close();
    },
  };

  return {
    innerForClient,
    appReceived,
    isServerConnected: () => serverConnected,
    getServerError: () => serverError,
    /** Encrypt bytes from the server toward the client. */
    serverSend: (bytes: Uint8Array) => {
      server.prepare(tls.bytesToBinaryString(bytes));
    },
    /** Simulate the underlying transport closing (TCP EOF, no TLS alert). */
    endInner: () => toClient.push(null),
  };
}

// ---------------------------------------------------------------------------
// Real TLS handshake + app-data round trip through the wrapped RawSocket.
// ---------------------------------------------------------------------------
describe('upgradeToTls (client) against an in-memory forge TLS server', () => {
  it('completes the handshake and moves bytes byte-exact in both directions', async () => {
    const pipe = makeServerPipe();
    const client = await tls.upgradeToTls(pipe.innerForClient, {
      host: 'test.local',
      rejectUnauthorized: false, // accept the self-signed test cert
    });

    expect(pipe.isServerConnected()).toBe(true);
    expect(pipe.getServerError()).toBeNull();

    // Client -> server: a payload covering the full 0..255 byte range twice.
    const outbound = new Uint8Array(512);
    for (let i = 0; i < outbound.length; i++) outbound[i] = i & 0xff;
    const n = await client.send(base64Encode(outbound));
    expect(n).toBe(outbound.length);

    const gotServer = concatChunks(pipe.appReceived);
    expect(Array.from(gotServer)).toEqual(Array.from(outbound));

    // Server -> client: distinct binary payload, decrypted by the wrapper.
    const inbound = Uint8Array.of(0, 1, 2, 250, 251, 252, 253, 254, 255, 42, 7, 0);
    pipe.serverSend(inbound);
    const rxB64 = await client.receive();
    expect(rxB64).not.toBeNull();
    expect(Array.from(base64Decode(rxB64!))).toEqual(Array.from(inbound));

    await client.close();
  }, 30_000);

  it('surfaces a transport EOF as receive() -> null', async () => {
    const pipe = makeServerPipe();
    const client = await tls.upgradeToTls(pipe.innerForClient, {
      host: 'test.local',
      rejectUnauthorized: false,
    });
    // Underlying TCP closes with no buffered app data -> wrapper reports EOF.
    pipe.endInner();
    const rx = await client.receive();
    expect(rx).toBeNull();
  }, 30_000);

  it('rejects an untrusted certificate when rejectUnauthorized is true', async () => {
    const pipe = makeServerPipe();
    await expect(
      tls.upgradeToTls(pipe.innerForClient, { host: 'test.local', rejectUnauthorized: true }),
    ).rejects.toBeTruthy();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// binary-string <-> bytes bridges are round-trip exact for all byte values.
// ---------------------------------------------------------------------------
describe('binaryString <-> bytes bridges', () => {
  it('round-trips every byte value', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    const s = tls.bytesToBinaryString(bytes);
    expect(s.length).toBe(256);
    expect(Array.from(tls.binaryStringToBytes(s))).toEqual(Array.from(bytes));
  });
});

// ---------------------------------------------------------------------------
// connectFtp explicit-FTPS command sequencing (upgradeToTls stubbed).
// ---------------------------------------------------------------------------

/** Scripted RawSocket: receive() yields queued replies; send() records commands. */
class ScriptedSocket implements RawSocket {
  sent: string[] = [];
  private queue: (string | null)[] = [];
  push(text: string): this {
    this.queue.push(base64Encode(new TextEncoder().encode(text)));
    return this;
  }
  async send(dataB64: string): Promise<number> {
    this.sent.push(new TextDecoder().decode(base64Decode(dataB64)));
    return dataB64.length;
  }
  async receive(): Promise<string | null> {
    return this.queue.length ? this.queue.shift()! : null;
  }
  async close(): Promise<void> {}
}

describe('connectFtp explicit FTPS sequencing', () => {
  beforeEach(() => {
    (upgradeToTls as unknown as Mock).mockReset();
  });

  it('does AUTH TLS -> upgrade -> USER/PASS -> PBSZ 0 -> PROT P on the encrypted channel', async () => {
    // Plaintext control before TLS: greeting then AUTH TLS acceptance.
    const plain = new ScriptedSocket().push('220 Service ready\r\n').push('234 AUTH TLS OK\r\n');
    // Post-upgrade (encrypted) control replies.
    const secure = new ScriptedSocket()
      .push('331 Need password\r\n') // USER
      .push('230 Logged in\r\n') // PASS
      .push('200 PBSZ=0\r\n') // PBSZ 0
      .push('200 Protection set to P\r\n') // PROT P
      .push('200 Type set to I\r\n') // TYPE I
      .push('200 UTF8 set to on\r\n') // OPTS UTF8 ON
      .push('257 "/home/bob" is the current directory\r\n'); // PWD

    (upgradeToTls as unknown as Mock).mockResolvedValueOnce(secure);
    const tcp = vi.fn().mockResolvedValue({ ok: true, socket: plain });

    const conn = await connectFtp(
      { host: 'ftp.example.com', port: 21, username: 'bob', password: 'pw', secure: true },
      undefined,
      { tcpConnect: tcp, rejectUnauthorized: true },
    );

    expect(conn.home).toBe('/home/bob');
    expect(plain.sent).toEqual(['AUTH TLS\r\n']);
    expect(secure.sent).toEqual([
      'USER bob\r\n',
      'PASS pw\r\n',
      'PBSZ 0\r\n',
      'PROT P\r\n',
      'TYPE I\r\n',
      'OPTS UTF8 ON\r\n',
      'PWD\r\n',
    ]);
    // Control socket was upgraded with the requested trust policy.
    expect(upgradeToTls).toHaveBeenCalledWith(plain, {
      host: 'ftp.example.com',
      rejectUnauthorized: true,
    });
  });

  it('falls back to AUTH SSL when AUTH TLS is rejected', async () => {
    const plain = new ScriptedSocket()
      .push('220 Service ready\r\n')
      .push('500 Unknown command\r\n') // AUTH TLS rejected
      .push('234 AUTH SSL OK\r\n'); // AUTH SSL accepted
    const secure = new ScriptedSocket()
      .push('331 Need password\r\n')
      .push('230 Logged in\r\n')
      .push('200 PBSZ=0\r\n')
      .push('200 Protection set to P\r\n')
      .push('200 Type set to I\r\n')
      .push('200 UTF8 on\r\n')
      .push('257 "/" is current\r\n');

    (upgradeToTls as unknown as Mock).mockResolvedValueOnce(secure);
    const tcp = vi.fn().mockResolvedValue({ ok: true, socket: plain });

    const conn = await connectFtp(
      { host: 'nas.lan', port: 21, username: 'u', password: 'p', secure: true },
      undefined,
      { tcpConnect: tcp, rejectUnauthorized: false },
    );

    expect(conn.home).toBe('/');
    expect(plain.sent).toEqual(['AUTH TLS\r\n', 'AUTH SSL\r\n']);
    expect(upgradeToTls).toHaveBeenCalledWith(plain, { host: 'nas.lan', rejectUnauthorized: false });
  });

  it('does not send AUTH/PBSZ/PROT for a plain (non-secure) connection', async () => {
    const plain = new ScriptedSocket()
      .push('220 Service ready\r\n')
      .push('331 Need password\r\n')
      .push('230 Logged in\r\n')
      .push('200 Type set to I\r\n')
      .push('200 UTF8 on\r\n')
      .push('257 "/pub" is current\r\n');
    const tcp = vi.fn().mockResolvedValue({ ok: true, socket: plain });

    const conn = await connectFtp(
      { host: 'ftp.example.com', port: 21, username: 'bob', password: 'pw' },
      undefined,
      { tcpConnect: tcp },
    );

    expect(conn.home).toBe('/pub');
    expect(plain.sent).toEqual(['USER bob\r\n', 'PASS pw\r\n', 'TYPE I\r\n', 'OPTS UTF8 ON\r\n', 'PWD\r\n']);
    expect(upgradeToTls).not.toHaveBeenCalled();
  });
});

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
