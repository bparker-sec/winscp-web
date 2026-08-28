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

  private c2sCipher: Cipher = new NoneCipher();
  private s2cCipher: Cipher = new NoneCipher();
  private c2sSeq = 0;
  private s2cSeq = 0;

  private sessionId: Uint8Array | null = null;
  private readonly channels = new Map<number, SshChannel>();
  private nextLocalChannel = 0;
  private readLoopStarted = false;
  private closed = false;

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
  private static readonly KEEPALIVE_INTERVAL_MS = 25_000;

  constructor(stream: ByteStream, opts: SshClientOptions) {
    this.stream = stream;
    this.host = opts.host;
    this.port = opts.port;
  }

  private send(payload: Uint8Array): Promise<void> {
    const run = this.sendChain.then(() =>
      this.stream.write(encodePacket(payload, this.c2sCipher, this.c2sSeq++)),
    );
    // Keep the chain alive even if a write rejects, so ordering survives errors.
    this.sendChain = run.catch(() => {});
    return run;
  }

  private startKeepalive(): void {
    if (this.keepaliveTimer || this.closed) return;
    this.keepaliveTimer = setInterval(() => {
      // want_reply=true so the server answers (REQUEST_SUCCESS/FAILURE), which
      // the read loop consumes — generating regular inbound traffic.
      void this.send(
        new SshWriter().byte(SSH_MSG_GLOBAL_REQUEST).string('keepalive@openssh.com').bool(true).finish(),
      ).catch(() => {});
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

    // 2. KEXINIT exchange + negotiation.
    const cookie = crypto.getRandomValues(new Uint8Array(16));
    const iClient = buildKexInit(cookie);
    await this.send(iClient);
    const iServer = await this.recvExpecting((m) => m === SSH_MSG_KEXINIT);
    const serverKex = parseKexInit(iServer);

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

    const keys = deriveSessionKeys(sharedSecret, h, this.sessionId);
    // The KDF always derives 32 bytes of key material; slice to the negotiated
    // cipher's actual key length (16 for aes128-gcm, 32 for aes256-gcm) per
    // direction — @noble/ciphers picks AES-128 vs AES-256 by key length.
    const keyC2S = keys.keyC2S.subarray(0, gcmKeyLength(cipherC2S));
    const keyS2C = keys.keyS2C.subarray(0, gcmKeyLength(cipherS2C));
    this.c2sCipher = new GcmCipher(keyC2S, keys.ivC2S);
    this.s2cCipher = new GcmCipher(keyS2C, keys.ivS2C);

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

  private teardownChannels(_err: Error): void {
    this.closed = true;
    this.stopKeepalive();
    for (const channel of this.channels.values()) {
      channel.onClose();
    }
    this.channels.clear();
  }

  async disconnect(): Promise<void> {
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
