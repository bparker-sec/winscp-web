// A TLS client layer over a raw base64 socket, implemented in pure JS with
// node-forge. FTPS needs to run a TLS handshake over the same host TCP proxy the
// plain FTP control/data channels use (the browser cannot open real sockets, and
// the proxy only relays raw bytes), so we cannot lean on the platform's TLS.
//
// forge implements TLS 1.0-1.2 over an abstract transport: it never touches a
// socket itself. We drive it by hand -- feed it inbound ciphertext via
// conn.process(), collect outbound ciphertext from the tlsDataReady callback and
// write it to the inner socket, and read decrypted application bytes from the
// dataReady callback. upgradeToTls() wraps all of that behind the same RawSocket
// interface, so callers (ByteStream, FtpDataConnection) are oblivious to TLS.
//
// forge's TLS is deliberately imported dynamically so it is code-split out of the
// main bundle: FTPS is opt-in and most sessions never touch it.

import { base64Encode, base64Decode } from '../net/base64';
import type { RawSocket } from '../net/ByteStream';

export interface UpgradeTlsOptions {
  /** SNI / virtual host name presented to the server. */
  host: string;
  /**
   * When true (the default), a certificate that does not chain to a trusted CA
   * aborts the handshake. When false, ANY server certificate is accepted --
   * including self-signed. That is convenient for a LAN NAS but removes the only
   * defense against a man-in-the-middle: an attacker who can intercept the TCP
   * stream can present their own cert and transparently read/modify everything.
   * Only set false for hosts the user explicitly trusts on a trusted network.
   */
  rejectUnauthorized?: boolean;
  /**
   * Optional override of the accept/reject decision. Receives whether forge's own
   * chain validation passed (certOk) and returns true to accept the certificate.
   * When provided it supersedes rejectUnauthorized.
   */
  verify?: (certOk: boolean) => boolean;
}

// ---------------------------------------------------------------------------
// binary-string <-> bytes bridges.
//
// forge represents wire bytes as "binary strings": a JS string in which each
// char code is one byte (0-255). The RawSocket transports base64 of raw bytes.
// These helpers convert between forge binary strings and Uint8Array so the two
// worlds meet; base64Encode/base64Decode bridge Uint8Array <-> base64.
// ---------------------------------------------------------------------------

const CHUNK = 0x8000; // keep String.fromCharCode argument counts small

/** forge binary string -> raw bytes. */
export function binaryStringToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** raw bytes -> forge binary string. */
export function bytesToBinaryString(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}

/** RFC 6125-ish match of one cert name (CN or DNS/IP SAN) against a host. */
export function matchesHostname(pattern: string, host: string): boolean {
  if (!pattern) return false;
  const p = pattern.toLowerCase();
  const h = host.toLowerCase();
  if (p === h) return true;
  // Single leftmost-label wildcard: *.example.com matches a.example.com (one label).
  if (p.startsWith('*.')) {
    const suffix = p.slice(1); // ".example.com"
    return h.endsWith(suffix) && h.slice(0, h.length - suffix.length).indexOf('.') === -1;
  }
  return false;
}

/**
 * Does the leaf certificate identify `host`? Checks subjectAltName DNS/IP
 * entries first (per RFC 6125), then falls back to the subject CN. `cert` is a
 * forge x509 certificate object.
 */
export function certMatchesHost(cert: unknown, host: string): boolean {
  const c = cert as {
    subject?: { getField?: (name: string) => { value?: string } | null };
    getExtension?: (name: string) => { altNames?: Array<{ type?: number; value?: string }> } | undefined;
  } | null;
  if (!c) return false;
  const names: string[] = [];
  const san = c.getExtension?.('subjectAltName');
  if (san?.altNames) {
    for (const alt of san.altNames) if (alt.value) names.push(alt.value);
  }
  const cn = c.subject?.getField?.('CN')?.value;
  if (cn) names.push(cn);
  return names.some((n) => matchesHostname(n, host));
}

/**
 * Run a TLS client handshake over `inner` and return a new RawSocket whose
 * send()/receive() transparently encrypt/decrypt through the TLS session. The
 * returned socket's close() sends a TLS close_notify then closes `inner`.
 */
export async function upgradeToTls(inner: RawSocket, opts: UpgradeTlsOptions): Promise<RawSocket> {
  const forge = (await import('node-forge')).default;
  const rejectUnauthorized = opts.rejectUnauthorized ?? true;

  // Outbound ciphertext queued by tlsDataReady (fires synchronously inside
  // handshake()/process()/prepare()); flushed to `inner` afterwards. inner.send
  // is serialized through sendChain so records never interleave on the wire.
  const outbound: string[] = [];
  let sendChain: Promise<void> = Promise.resolve();

  // Decrypted application bytes queued by dataReady, drained by receive().
  const inboundApp: string[] = [];

  let handshakeDone = false;
  let peerClosed = false;
  let tlsError: Error | null = null;

  const conn = forge.tls.createConnection({
    server: false,
    virtualHost: opts.host,
    verify: (_conn, verified, _depth, certs) => {
      const certOk = verified === true;
      // Explicit "accept anything" — opt-in per host for self-signed certs on a
      // trusted network. The MITM tradeoff is documented above; the caller chose
      // it, so skip both chain and hostname checks.
      if (rejectUnauthorized === false) return true;
      if (opts.verify) return opts.verify(certOk) ? true : verified;
      // Secure default: require forge's chain verdict AND that the leaf cert was
      // actually issued for this host (forge does not check the hostname itself).
      if (verified !== true) return verified;
      if (!certMatchesHost(certs && certs[0], opts.host)) {
        tlsError = new Error(
          `FTPS certificate hostname mismatch: not valid for ${opts.host}.`,
        );
        // Returning a non-true value fails the handshake with a bad_certificate
        // alert; cast because @types/node-forge narrows the callback return.
        return forge.tls.Alert.Description.bad_certificate as unknown as typeof verified;
      }
      return true;
    },
    connected: () => {
      handshakeDone = true;
    },
    tlsDataReady: (c) => {
      // Ciphertext ready to go out on the wire.
      const bytes = c.tlsData.getBytes();
      if (bytes.length > 0) outbound.push(bytes);
    },
    dataReady: (c) => {
      // Decrypted application data ready for the consumer.
      const bytes = c.data.getBytes();
      if (bytes.length > 0) inboundApp.push(bytes);
    },
    closed: () => {
      peerClosed = true;
    },
    error: (_c, e) => {
      tlsError = e instanceof Error ? e : new Error(String((e as { message?: string })?.message ?? e));
    },
  });

  /** Push any queued outbound ciphertext to the inner socket, in order. */
  function flushOutbound(): Promise<void> {
    if (outbound.length === 0) return sendChain;
    const records = outbound.splice(0);
    sendChain = sendChain.then(async () => {
      for (const rec of records) {
        const n = await inner.send(base64Encode(binaryStringToBytes(rec)));
        if (n === null) throw new Error('TLS transport send failed (inner socket unavailable).');
      }
    });
    return sendChain;
  }

  /** Feed one inbound base64 chunk (or EOF) into forge; returns false at EOF. */
  async function pumpOne(): Promise<boolean> {
    const chunkB64 = await inner.receive();
    if (chunkB64 === null) return false;
    conn.process(bytesToBinaryString(base64Decode(chunkB64)));
    await flushOutbound();
    if (tlsError) throw tlsError;
    return true;
  }

  // --- Drive the handshake to completion. -----------------------------------
  conn.handshake();
  await flushOutbound();
  if (tlsError) throw tlsError;
  while (!handshakeDone) {
    if (tlsError) throw tlsError;
    const alive = await pumpOne();
    if (!alive) throw tlsError ?? new Error('TLS handshake failed: connection closed by peer.');
  }

  // receive() is expected to be called sequentially (ByteStream / FtpDataConnection
  // pull one chunk at a time); a small chain guards against overlap anyway.
  let recvChain: Promise<string | null> = Promise.resolve('');

  async function drainOrPump(): Promise<string | null> {
    for (;;) {
      if (inboundApp.length > 0) {
        const joined = inboundApp.splice(0).join('');
        if (joined.length > 0) return base64Encode(binaryStringToBytes(joined));
      }
      if (peerClosed || tlsError) {
        if (tlsError) throw tlsError;
        return null; // clean TLS shutdown -> EOF for the consumer
      }
      const alive = await pumpOne();
      if (!alive) {
        // inner socket closed without close_notify; surface remaining app bytes
        // then EOF.
        if (inboundApp.length > 0) continue;
        return null;
      }
    }
  }

  return {
    async send(dataBase64: string): Promise<number | null> {
      if (tlsError) throw tlsError;
      const bytes = base64Decode(dataBase64);
      conn.prepare(bytesToBinaryString(bytes)); // encrypt -> tlsDataReady
      await flushOutbound();
      if (tlsError) throw tlsError;
      return bytes.length;
    },
    receive(): Promise<string | null> {
      const next = recvChain.then(() => drainOrPump());
      // keep the chain alive but don't let a rejection poison later calls
      recvChain = next.then(
        () => '',
        () => '',
      );
      return next;
    },
    async close(): Promise<void> {
      try {
        conn.close();
        await flushOutbound();
      } catch {
        // best effort -- we're tearing down regardless
      }
      await inner.close();
    },
  };
}
