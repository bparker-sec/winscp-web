// SshClient: orchestration facade wiring identification -> KEXINIT -> curve25519
// KEX -> NEWKEYS/cipher swap -> userauth -> channel open, plus a background
// read-loop dispatching inbound packets to open channels (RFC 4253/4252/4254).

import type { ByteStream } from '../net/ByteStream';
import { SshWriter, SshReader } from './wire';
import { exchangeIdentification } from './identification';
import { NoneCipher, GcmCipher, encodePacket, readPacket, type Cipher } from './packet';
import {
  buildKexInit,
  parseKexInit,
  negotiate,
  computeExchangeHash,
  verifyHostSignature,
  deriveSessionKeys,
  gcmKeyLength,
  CLIENT_KEX_ALGORITHMS,
  CLIENT_HOST_KEY_ALGORITHMS,
  CLIENT_CIPHER_ALGORITHMS,
} from './kex';
import { x25519KeyPair, x25519SharedSecret } from './crypto/x25519';
import { checkHostKey, rememberHost, type HostKeyCheck } from './knownhosts';
import { buildServiceRequest, buildPasswordAuth, signPublicKeyAuth, parseUserAuthResult } from './userauth';
import {
  buildChannelOpenSession,
  buildSubsystemRequest,
  parseChannelOpenConfirmation,
  parseChannelData,
  parseWindowAdjust,
  SshChannel,
} from './channel';
import {
  SSH_MSG_DISCONNECT,
  SSH_MSG_IGNORE,
  SSH_MSG_DEBUG,
  SSH_MSG_SERVICE_ACCEPT,
  SSH_MSG_KEXINIT,
  SSH_MSG_NEWKEYS,
  SSH_MSG_KEX_ECDH_INIT,
  SSH_MSG_KEX_ECDH_REPLY,
  SSH_MSG_USERAUTH_SUCCESS,
  SSH_MSG_USERAUTH_FAILURE,
  SSH_MSG_GLOBAL_REQUEST,
  SSH_MSG_REQUEST_FAILURE,
  SSH_MSG_USERAUTH_BANNER,
  SSH_MSG_CHANNEL_OPEN_CONFIRMATION,
  SSH_MSG_CHANNEL_OPEN_FAILURE,
  SSH_MSG_CHANNEL_SUCCESS,
  SSH_MSG_CHANNEL_FAILURE,
  SSH_MSG_CHANNEL_DATA,
  SSH_MSG_CHANNEL_WINDOW_ADJUST,
  SSH_MSG_CHANNEL_EOF,
  SSH_MSG_CHANNEL_CLOSE,
} from './constants';

const DEFAULT_CHANNEL_WINDOW = 2 * 1024 * 1024;
const DEFAULT_MAX_PACKET = 32768;

export interface SshClientOptions {
  host: string;
  port: number;
  /**
   * Called at most once when the connection is unexpectedly lost (transport
   * error, peer DISCONNECT, or a failed keepalive send indicating the peer
   * TCP is gone). NOT called on an intentional `disconnect()`.
   */
  onClosed?: (reason: string) => void;
}

export type TrustCallback = (info: {
  host: string;
  port: number;
  fingerprint: string;
  status: HostKeyCheck['status'];
}) => boolean | Promise<boolean>;

export interface AuthCredentials {
  username: string;
  password?: string;
  privateKey?: { seed: Uint8Array; publicKey: Uint8Array };
}

/** Thrown when the peer sends SSH_MSG_DISCONNECT. */
export class SshDisconnectError extends Error {
  constructor(
    public readonly code: number,
    reason: string,
  ) {
    super(`SSH disconnect (code ${code}): ${reason}`);
  }
}

function parseDisconnect(payload: Uint8Array): { code: number; reason: string } {
  const r = new SshReader(payload);
  r.byte(); // SSH_MSG_DISCONNECT
  const code = r.uint32();
  const reason = new TextDecoder().decode(r.string());
  return { code, reason };
}

/**
 * Orchestrates a full SSH2 client session over a `ByteStream`: identification,
 * KEXINIT negotiation, curve25519 KEX + host-key TOFU verification, NEWKEYS
 * (swapping to AES-GCM), userauth, and channel/subsystem opening. After
 * `openSubsystem` starts the background read-loop, inbound CHANNEL_* traffic
 * is dispatched to the corresponding `SshChannel`.
 */
export class SshClient {
  private readonly stream: ByteStream;
  private readonly host: string;
  private readonly port: number;
  private readonly onClosed?: (reason: string) => void;
  private notifiedClosed = false;

  private c2sCipher: Cipher = new NoneCipher();
  private s2cCipher: Cipher = new NoneCipher();
  private c2sSeq = 0;
  private s2cSeq = 0;

  private sessionId: Uint8Array | null = null;
  private readonly channels = new Map<number, SshChannel>();
  private nextLocalChannel = 0;
  private readLoopStarted = false;
  private closed = false;

  // Client identification strings, retained from connect() so a later key
  // re-exchange (rekey) can recompute the exchange hash H. The session id is the
  // FIRST exchange hash and never changes; only H and the derived keys rotate.
  private vClient: Uint8Array | null = null;
  private vServer: Uint8Array | null = null;

  // Rekey state (RFC 4253 §9). OpenSSH forces a key re-exchange after ~1 GiB (or
  // ~1 h); without handling it a multi-GB transfer would stall the moment the
  // server sends its mid-stream SSH_MSG_KEXINIT. While a rekey is in progress the
  // gate below holds outgoing connection-protocol traffic (channel data, channel/
  // global requests) — RFC 4253 §7.1 forbids sending anything but transport and
  // KEX messages between our KEXINIT and our NEWKEYS. Transport/KEX messages
  // (msg number < 50) always flow so the exchange can complete.
  private rekeyGate: Promise<void> | null = null;
  private rekeyGateResolve: (() => void) | null = null;
  // Our KEXINIT payload when WE initiated the rekey (via requestRekey), so the
  // readLoop's KEXINIT handler reuses it instead of sending a second one.
  private sentRekeyKexInit: Uint8Array | null = null;

  // Serializes outgoing packets: encoding assigns the packet sequence number and
  // advances the cipher IV, and the bytes must reach the wire in that exact
  // order. Without this, a keepalive firing between two SFTP writes (or two
  // concurrent operations) could interleave and desync the stream → the server
  // drops the connection. Each send waits for the previous one to finish.
  private sendChain: Promise<void> = Promise.resolve();

  // Keepalive: an idle SSH connection over the host TCP proxy would otherwise
  // stall the read loop on a receive with no traffic; a periodic global request
  // keeps data flowing and detects a dead peer promptly.
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  // Kept below the host receive-RPC idle window so the keepalive reply is regular
  // inbound traffic that resets the idle-timeout counter in sdk/tcp — a healthy
  // idle connection is never mistaken for a dead one.
  private static readonly KEEPALIVE_INTERVAL_MS = 15_000;

  constructor(stream: ByteStream, opts: SshClientOptions) {
    this.stream = stream;
    this.host = opts.host;
    this.port = opts.port;
    this.onClosed = opts.onClosed;
  }

  private async send(payload: Uint8Array): Promise<void> {
    // During a key re-exchange, hold connection-protocol traffic (channel data,
    // channel/global requests; msg number >= 50) until the new keys are
    // installed. Transport and KEX messages (< 50) must still flow to drive the
    // exchange to completion. Waiting BEFORE joining the send chain means a held
    // message doesn't occupy a chain slot ahead of the KEX messages.
    const gate = this.rekeyGate;
    if (gate && payload[0] >= 50) {
      await gate;
    }
    const run = this.sendChain.then(() =>
      this.stream.write(encodePacket(payload, this.c2sCipher, this.c2sSeq++)),
    );
    // Keep the chain alive even if a write rejects, so ordering survives errors.
    this.sendChain = run.catch(() => {});
    return run;
  }

  private openRekeyGate(): void {
    if (this.rekeyGate) return;
    this.rekeyGate = new Promise<void>((resolve) => {
      this.rekeyGateResolve = resolve;
    });
  }

  private closeRekeyGate(): void {
    const resolve = this.rekeyGateResolve;
    this.rekeyGate = null;
    this.rekeyGateResolve = null;
    resolve?.();
  }

  /** Negotiate + validate the algorithms from a server KEXINIT (initial or rekey). */
  private negotiateAlgos(serverKex: ReturnType<typeof parseKexInit>): {
    cipherC2S: string;
    cipherS2C: string;
  } {
    const kexAlgo = negotiate(CLIENT_KEX_ALGORITHMS, serverKex.kex);
    const hostKeyAlgo = negotiate(CLIENT_HOST_KEY_ALGORITHMS, serverKex.hostKey);
    const cipherC2S = negotiate(CLIENT_CIPHER_ALGORITHMS, serverKex.cipherC2S);
    const cipherS2C = negotiate(CLIENT_CIPHER_ALGORITHMS, serverKex.cipherS2C);
    if (!kexAlgo.startsWith('curve25519-sha256')) {
      throw new Error(`Unsupported negotiated kex algorithm: ${kexAlgo}`);
    }
    if (hostKeyAlgo !== 'ssh-ed25519') {
      throw new Error(`Unsupported negotiated host-key algorithm: ${hostKeyAlgo}`);
    }
    if (!cipherC2S.endsWith('-gcm@openssh.com') || !cipherS2C.endsWith('-gcm@openssh.com')) {
      throw new Error(`Unsupported negotiated cipher: c2s=${cipherC2S} s2c=${cipherS2C}`);
    }
    return { cipherC2S, cipherS2C };
  }

  /** Derive the per-direction GCM ciphers from a shared secret + exchange hash. */
  private buildCiphers(
    sharedSecret: Uint8Array,
    h: Uint8Array,
    cipherC2S: string,
    cipherS2C: string,
  ): { c2s: GcmCipher; s2c: GcmCipher } {
    // sessionId is the FIRST exchange hash and is fixed for the connection; a
    // rekey feeds the new H but keeps this original session id in the KDF.
    const keys = deriveSessionKeys(sharedSecret, h, this.sessionId!);
    // The KDF always derives 32 bytes; slice to the negotiated cipher's actual
    // key length (16 for aes128-gcm, 32 for aes256-gcm) per direction.
    const keyC2S = keys.keyC2S.subarray(0, gcmKeyLength(cipherC2S));
    const keyS2C = keys.keyS2C.subarray(0, gcmKeyLength(cipherS2C));
    return {
      c2s: new GcmCipher(keyC2S, keys.ivC2S),
      s2c: new GcmCipher(keyS2C, keys.ivS2C),
    };
  }

  /**
   * Read packets during a rekey, skipping IGNORE/DEBUG and throwing on
   * DISCONNECT, until `expected` arrives. Any stray connection-protocol message
   * (e.g. a data packet the server queued just before its KEXINIT) is routed to
   * its channel rather than dropped. Never SENDS anything (unlike recvExpecting,
   * whose GLOBAL_REQUEST reply would deadlock against the rekey gate).
   */
  private async recvKexPacket(expected: number): Promise<Uint8Array> {
    for (;;) {
      const payload = await this.recv();
      const msgNum = payload[0];
      if (msgNum === SSH_MSG_DISCONNECT) {
        const { code, reason } = parseDisconnect(payload);
        throw new SshDisconnectError(code, reason);
      }
      if (msgNum === SSH_MSG_IGNORE || msgNum === SSH_MSG_DEBUG) continue;
      if (msgNum === expected) return payload;
      this.dispatchChannelMessage(msgNum, payload);
    }
  }

  /**
   * Ask for a key re-exchange. Clients normally rely on the server to initiate
   * one at its RekeyLimit, but this lets callers (and tests) force one. Opens
   * the gate and sends our KEXINIT; the readLoop completes the exchange when the
   * server's KEXINIT arrives. No-op if closed or a rekey is already underway.
   */
  async requestRekey(): Promise<void> {
    if (this.closed || this.rekeyGate || this.sentRekeyKexInit) return;
    this.openRekeyGate();
    const iClient = buildKexInit(crypto.getRandomValues(new Uint8Array(16)));
    this.sentRekeyKexInit = iClient;
    await this.send(iClient); // KEXINIT (msg 20) — not held by the gate
  }

  /**
   * Drive a key re-exchange to completion in response to a server (or our own)
   * KEXINIT, delivered by the readLoop. Runs entirely within the read loop's
   * turn, so its own recv() calls consume the following KEX packets in order.
   * Sequence numbers continue across the rekey; only the ciphers rotate, each
   * swapped at the exact NEWKEYS boundary for its direction.
   */
  private async performRekey(iServer: Uint8Array): Promise<void> {
    this.openRekeyGate();
    try {
      const serverKex = parseKexInit(iServer);
      const { cipherC2S, cipherS2C } = this.negotiateAlgos(serverKex);

      // Our KEXINIT: reuse the one requestRekey() already sent (client-initiated),
      // otherwise send one now (server-initiated).
      let iClient = this.sentRekeyKexInit;
      if (!iClient) {
        iClient = buildKexInit(crypto.getRandomValues(new Uint8Array(16)));
        await this.send(iClient);
      }

      // curve25519 ECDH.
      const { secret, publicKey: qClient } = x25519KeyPair();
      await this.send(new SshWriter().byte(SSH_MSG_KEX_ECDH_INIT).string(qClient).finish());
      const replyPayload = await this.recvKexPacket(SSH_MSG_KEX_ECDH_REPLY);
      const replyReader = new SshReader(replyPayload);
      replyReader.byte(); // SSH_MSG_KEX_ECDH_REPLY
      const kServer = replyReader.string();
      const qServer = replyReader.string();
      const sig = replyReader.string();

      const sharedSecret = x25519SharedSecret(secret, qServer);
      const h = computeExchangeHash({
        vClient: this.vClient!,
        vServer: this.vServer!,
        iClient,
        iServer,
        kServer,
        qClient,
        qServer,
        sharedSecret,
      });

      // Host key must still verify AND match the key pinned on first connect.
      if (!verifyHostSignature(kServer, sig, h)) {
        throw new Error('SSH rekey host-key signature verification failed.');
      }
      const check = checkHostKey(this.host, this.port, kServer);
      if (check.status === 'mismatch') {
        throw new Error(
          `SSH host key for ${this.host}:${this.port} changed during rekey (got ${check.fingerprint}). Possible man-in-the-middle attack.`,
        );
      }

      const { c2s, s2c } = this.buildCiphers(sharedSecret, h, cipherC2S, cipherS2C);

      // NEWKEYS handshake. Both NEWKEYS are sent/received under the OLD keys;
      // swap c2s only after ours is on the wire, and s2c only after the server's
      // is read, so the boundary is exact in each direction.
      await this.send(new SshWriter().byte(SSH_MSG_NEWKEYS).finish());
      this.c2sCipher = c2s;
      await this.recvKexPacket(SSH_MSG_NEWKEYS);
      this.s2cCipher = s2c;
    } finally {
      this.sentRekeyKexInit = null;
      this.closeRekeyGate();
    }
  }

  private startKeepalive(): void {
    if (this.keepaliveTimer || this.closed) return;
    this.keepaliveTimer = setInterval(() => {
      // want_reply=true so the server answers (REQUEST_SUCCESS/FAILURE), which
      // the read loop consumes — generating regular inbound traffic.
      void this.send(
        new SshWriter().byte(SSH_MSG_GLOBAL_REQUEST).string('keepalive@openssh.com').bool(true).finish(),
      ).catch((err: unknown) => {
        // A failed send means the underlying TCP is gone — detect that dead
        // connection now (~within one keepalive interval) rather than waiting
        // for a stalled receive to eventually notice.
        this.teardownChannels(err instanceof Error ? err : new Error(String(err)));
      });
    }, SshClient.KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  private async recv(): Promise<Uint8Array> {
    return readPacket(this.stream, this.s2cCipher, this.s2cSeq++);
  }

  /**
   * Receive packets, transparently handling IGNORE/DEBUG/GLOBAL_REQUEST/BANNER
   * and throwing on DISCONNECT, until one matches `pred`.
   */
  private async recvExpecting(pred: (msgNum: number, payload: Uint8Array) => boolean): Promise<Uint8Array> {
    for (;;) {
      const payload = await this.recv();
      const msgNum = payload[0];

      if (msgNum === SSH_MSG_DISCONNECT) {
        const { code, reason } = parseDisconnect(payload);
        throw new SshDisconnectError(code, reason);
      }
      if (msgNum === SSH_MSG_IGNORE || msgNum === SSH_MSG_DEBUG || msgNum === SSH_MSG_USERAUTH_BANNER) {
        continue;
      }
      if (msgNum === SSH_MSG_GLOBAL_REQUEST) {
        await this.handleGlobalRequest(payload);
        continue;
      }
      if (pred(msgNum, payload)) {
        return payload;
      }
      // Not the awaited message: route channel traffic to its channel rather
      // than dropping it. This matters when a server opens a channel with a
      // zero window and immediately sends a CHANNEL_WINDOW_ADJUST that arrives
      // before the awaited CHANNEL_SUCCESS — dropping it would deadlock the
      // first write. Anything else is ignored.
      this.dispatchChannelMessage(msgNum, payload);
    }
  }

  /** Route an inbound CHANNEL_* message to its owning channel. Returns true if handled. */
  private dispatchChannelMessage(msgNum: number, payload: Uint8Array): boolean {
    switch (msgNum) {
      case SSH_MSG_CHANNEL_DATA: {
        const { recipient, data } = parseChannelData(payload);
        this.channels.get(recipient)?.onData(data);
        return true;
      }
      case SSH_MSG_CHANNEL_WINDOW_ADJUST: {
        const { recipient, bytesToAdd } = parseWindowAdjust(payload);
        this.channels.get(recipient)?.onWindowAdjust(bytesToAdd);
        return true;
      }
      case SSH_MSG_CHANNEL_EOF: {
        const r = new SshReader(payload);
        r.byte();
        this.channels.get(r.uint32())?.onEof();
        return true;
      }
      case SSH_MSG_CHANNEL_CLOSE: {
        const r = new SshReader(payload);
        r.byte();
        const recipient = r.uint32();
        this.channels.get(recipient)?.onClose();
        this.channels.delete(recipient);
        return true;
      }
      default:
        return false;
    }
  }

  private async handleGlobalRequest(payload: Uint8Array): Promise<void> {
    const r = new SshReader(payload);
    r.byte(); // SSH_MSG_GLOBAL_REQUEST
    r.string(); // request name, unused
    const wantReply = r.bool();
    if (wantReply) {
      await this.send(new SshWriter().byte(SSH_MSG_REQUEST_FAILURE).finish());
    }
  }

  async connect(trust?: TrustCallback): Promise<{ fingerprint: string }> {
    // 1. Identification exchange.
    const { clientId, serverId } = await exchangeIdentification(this.stream);
    const vClient = new TextEncoder().encode(clientId);
    const vServer = new TextEncoder().encode(serverId);
    // Retained for any later rekey, which recomputes H from the same V_C/V_S.
    this.vClient = vClient;
    this.vServer = vServer;

    // 2. KEXINIT exchange + negotiation.
    const cookie = crypto.getRandomValues(new Uint8Array(16));
    const iClient = buildKexInit(cookie);
    await this.send(iClient);
    const iServer = await this.recvExpecting((m) => m === SSH_MSG_KEXINIT);
    const serverKex = parseKexInit(iServer);
    const { cipherC2S, cipherS2C } = this.negotiateAlgos(serverKex);

    // 3. curve25519 ECDH.
    const { secret, publicKey: qClient } = x25519KeyPair();
    await this.send(new SshWriter().byte(SSH_MSG_KEX_ECDH_INIT).string(qClient).finish());
    const replyPayload = await this.recvExpecting((m) => m === SSH_MSG_KEX_ECDH_REPLY);
    const replyReader = new SshReader(replyPayload);
    replyReader.byte(); // SSH_MSG_KEX_ECDH_REPLY
    const kServer = replyReader.string();
    const qServer = replyReader.string();
    const sig = replyReader.string();

    const sharedSecret = x25519SharedSecret(secret, qServer);
    const h = computeExchangeHash({
      vClient,
      vServer,
      iClient,
      iServer,
      kServer,
      qClient,
      qServer,
      sharedSecret,
    });
    this.sessionId = h;

    // 4. Host-key verification + TOFU.
    if (!verifyHostSignature(kServer, sig, h)) {
      throw new Error('SSH host-key signature verification failed.');
    }
    const check = checkHostKey(this.host, this.port, kServer);
    if (check.status === 'mismatch') {
      throw new Error(
        `SSH host key for ${this.host}:${this.port} has changed! Expected fingerprint ${check.known}, got ${check.fingerprint}. Possible man-in-the-middle attack.`,
      );
    }
    const accepted = trust ? await trust({ host: this.host, port: this.port, fingerprint: check.fingerprint, status: check.status }) : true;
    if (!accepted) {
      throw new Error(`SSH host key for ${this.host}:${this.port} was not trusted by the caller.`);
    }
    if (check.status === 'new') {
      rememberHost(this.host, this.port, check.fingerprint);
    }

    // 5. NEWKEYS + cipher swap. Packet sequence numbers do NOT reset here
    // (RFC 4253 §7.2/§6.4); the GCM IV counter is independent, seeded fresh
    // from the KDF, and starts at zero for each direction.
    await this.send(new SshWriter().byte(SSH_MSG_NEWKEYS).finish());
    await this.recvExpecting((m) => m === SSH_MSG_NEWKEYS);

    const { c2s, s2c } = this.buildCiphers(sharedSecret, h, cipherC2S, cipherS2C);
    this.c2sCipher = c2s;
    this.s2cCipher = s2c;

    return { fingerprint: check.fingerprint };
  }

  async authenticate(creds: AuthCredentials): Promise<void> {
    if (!this.sessionId) {
      throw new Error('SshClient.authenticate called before connect().');
    }

    await this.send(buildServiceRequest('ssh-userauth'));
    await this.recvExpecting((m) => m === SSH_MSG_SERVICE_ACCEPT);

    if (creds.privateKey) {
      await this.send(
        signPublicKeyAuth({
          sessionId: this.sessionId,
          user: creds.username,
          seed: creds.privateKey.seed,
          publicKey: creds.privateKey.publicKey,
        }),
      );
    } else if (creds.password !== undefined) {
      await this.send(buildPasswordAuth(creds.username, creds.password));
    } else {
      throw new Error('authenticate() requires either password or privateKey.');
    }

    const resultPayload = await this.recvExpecting(
      (m) => m === SSH_MSG_USERAUTH_SUCCESS || m === SSH_MSG_USERAUTH_FAILURE,
    );
    const result = parseUserAuthResult(resultPayload);
    if (result.type === 'failure') {
      throw new Error(`SSH authentication failed. Methods that can continue: ${result.methods.join(', ') || '(none)'}`);
    }
    if (result.type !== 'success') {
      throw new Error(`Unexpected userauth result: ${JSON.stringify(result)}`);
    }
  }

  async openSubsystem(name: string): Promise<SshChannel> {
    if (this.readLoopStarted) {
      throw new Error('SshClient supports a single subsystem/channel per connection.');
    }
    const local = this.nextLocalChannel++;
    await this.send(buildChannelOpenSession(local, DEFAULT_CHANNEL_WINDOW, DEFAULT_MAX_PACKET));

    const openPayload = await this.recvExpecting(
      (m) => m === SSH_MSG_CHANNEL_OPEN_CONFIRMATION || m === SSH_MSG_CHANNEL_OPEN_FAILURE,
    );
    if (openPayload[0] === SSH_MSG_CHANNEL_OPEN_FAILURE) {
      throw new Error(`SSH channel open failed for local channel ${local}.`);
    }
    const confirmation = parseChannelOpenConfirmation(openPayload);

    const channel = new SshChannel({
      send: (p) => this.send(p),
      localChannel: local,
      remoteChannel: confirmation.sender,
      remoteWindow: confirmation.window,
      maxPacket: confirmation.maxPacket,
      localWindow: DEFAULT_CHANNEL_WINDOW,
    });
    this.channels.set(local, channel);

    await this.send(buildSubsystemRequest(confirmation.sender, name, true));
    const reqResult = await this.recvExpecting((m) => m === SSH_MSG_CHANNEL_SUCCESS || m === SSH_MSG_CHANNEL_FAILURE);
    if (reqResult[0] === SSH_MSG_CHANNEL_FAILURE) {
      this.channels.delete(local);
      throw new Error(`SSH subsystem "${name}" request failed on channel ${local}.`);
    }

    if (!this.readLoopStarted) {
      this.readLoopStarted = true;
      this.startKeepalive();
      void this.readLoop();
    }

    return channel;
  }

  /** Background dispatcher: routes inbound CHANNEL_* traffic to the owning SshChannel. */
  private async readLoop(): Promise<void> {
    try {
      for (;;) {
        const payload = await this.recv();
        const msgNum = payload[0];

        if (msgNum === SSH_MSG_DISCONNECT) {
          const { code, reason } = parseDisconnect(payload);
          this.teardownChannels(new SshDisconnectError(code, reason));
          return;
        }
        if (msgNum === SSH_MSG_KEXINIT) {
          // Server-initiated (or reply to our) key re-exchange. Drive it to
          // completion before resuming normal dispatch; new keys take effect
          // atomically at the NEWKEYS boundary.
          await this.performRekey(payload);
          continue;
        }
        if (msgNum === SSH_MSG_GLOBAL_REQUEST) {
          await this.handleGlobalRequest(payload);
          continue;
        }
        if (msgNum === SSH_MSG_IGNORE || msgNum === SSH_MSG_DEBUG || msgNum === SSH_MSG_USERAUTH_BANNER) {
          continue;
        }
        // CHANNEL_* → routed to the owning channel; anything else ignored.
        this.dispatchChannelMessage(msgNum, payload);
      }
    } catch (err) {
      this.teardownChannels(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private teardownChannels(err: Error): void {
    const alreadyClosed = this.closed;
    this.closed = true;
    this.stopKeepalive();
    const reason = err.message || 'transport closed';
    for (const channel of this.channels.values()) {
      channel.onClose(reason);
    }
    this.channels.clear();
    // Release the underlying TCP socket. Without this, a lost connection leaves
    // the host-side socket open; repeated auto-reconnects then leak sockets until
    // the host hits its per-app socket limit and refuses further connections.
    if (!alreadyClosed) {
      void this.stream.close().catch(() => {});
    }
    if (!this.notifiedClosed) {
      this.notifiedClosed = true;
      this.onClosed?.(reason);
    }
  }

  async disconnect(): Promise<void> {
    // User-initiated: suppress the onClosed notification that teardownChannels
    // would otherwise fire, since this isn't an unexpected connection loss.
    this.notifiedClosed = true;
    this.closed = true;
    this.stopKeepalive();
    try {
      await this.send(
        new SshWriter().byte(SSH_MSG_DISCONNECT).uint32(11 /* SSH_DISCONNECT_BY_APPLICATION */).string('').string('').finish(),
      );
    } catch {
      // best-effort
    }
    try {
      await this.stream.close();
    } catch {
      // best-effort
    }
  }
}
