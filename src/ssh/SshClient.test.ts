import { describe, it, expect, vi } from 'vitest';
import { ByteStream, type RawSocket } from '../net/ByteStream';
import { base64Encode } from '../net/base64';
import { SshWriter } from './wire';
import { NoneCipher, GcmCipher, encodePacket } from './packet';
import { SshChannel } from './channel';
import { SshClient, SshDisconnectError } from './SshClient';
import {
  SSH_MSG_IGNORE,
  SSH_MSG_DEBUG,
  SSH_MSG_USERAUTH_BANNER,
  SSH_MSG_GLOBAL_REQUEST,
  SSH_MSG_REQUEST_FAILURE,
  SSH_MSG_DISCONNECT,
  SSH_MSG_NEWKEYS,
  SSH_MSG_CHANNEL_DATA,
  SSH_MSG_CHANNEL_WINDOW_ADJUST,
  SSH_MSG_CHANNEL_EOF,
  SSH_MSG_CHANNEL_CLOSE,
  SSH_MSG_CHANNEL_OPEN_CONFIRMATION,
  SSH_MSG_CHANNEL_SUCCESS,
} from './constants';

/** Records everything written and hands out a scripted queue of raw bytes on receive(). */
class FakeSocket implements RawSocket {
  sentBytes: Uint8Array[] = [];
  private queue: (string | null)[];
  constructor(bytes: Uint8Array) {
    this.queue = [base64Encode(bytes)];
  }
  async send(dataBase64: string) {
    this.sentBytes.push(new Uint8Array(Buffer.from(dataBase64, 'base64')));
    return 1;
  }
  async receive() {
    return this.queue.length ? this.queue.shift()! : null;
  }
  async close() {}
}

function concatAll(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function newClient(scriptedPackets: Uint8Array[]): { client: SshClient; socket: FakeSocket } {
  const encoded = scriptedPackets.map((p) => encodePacket(p, new NoneCipher(), 0));
  const socket = new FakeSocket(concatAll(encoded));
  const stream = new ByteStream(socket);
  const client = new SshClient(stream, { host: 'example.com', port: 22 });
  return { client, socket };
}

function globalRequestPacket(wantReply: boolean): Uint8Array {
  return new SshWriter().byte(SSH_MSG_GLOBAL_REQUEST).string('foo@example.com').bool(wantReply).finish();
}

function disconnectPacket(code: number, reason: string): Uint8Array {
  return new SshWriter().byte(SSH_MSG_DISCONNECT).uint32(code).string(reason).string('').finish();
}

describe('SshClient.recvExpecting (private, exercised via cast)', () => {
  it('skips IGNORE/DEBUG/GLOBAL_REQUEST/BANNER, replies failure to want_reply GLOBAL_REQUEST, and returns the first match', async () => {
    const target = new SshWriter().byte(SSH_MSG_NEWKEYS).finish();
    const { client, socket } = newClient([
      new SshWriter().byte(SSH_MSG_IGNORE).finish(),
      new SshWriter().byte(SSH_MSG_DEBUG).bool(false).string('hi').string('').finish(),
      globalRequestPacket(true),
      new SshWriter().byte(SSH_MSG_USERAUTH_BANNER).string('welcome').string('').finish(),
      target,
    ]);

    const result = await (client as any).recvExpecting((m: number) => m === SSH_MSG_NEWKEYS);
    expect(result[0]).toBe(SSH_MSG_NEWKEYS);

    // A REQUEST_FAILURE should have been sent in response to the want_reply GLOBAL_REQUEST.
    expect(socket.sentBytes.length).toBe(1);
    const sentPayload = decodeNoneCipherPacket(socket.sentBytes[0]);
    expect(sentPayload[0]).toBe(SSH_MSG_REQUEST_FAILURE);
  });

  it('does not reply when GLOBAL_REQUEST want_reply is false', async () => {
    const target = new SshWriter().byte(SSH_MSG_NEWKEYS).finish();
    const { client, socket } = newClient([globalRequestPacket(false), target]);
    await (client as any).recvExpecting((m: number) => m === SSH_MSG_NEWKEYS);
    expect(socket.sentBytes.length).toBe(0);
  });

  it('throws SshDisconnectError with the reason on DISCONNECT', async () => {
    const { client } = newClient([disconnectPacket(11, 'bye')]);
    let caught: unknown;
    try {
      await (client as any).recvExpecting((m: number) => m === 999);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SshDisconnectError);
    expect((caught as SshDisconnectError).message).toMatch(/bye/);
  });
});

describe('SshClient readLoop dispatch', () => {
  it('routes CHANNEL_DATA/WINDOW_ADJUST/EOF/CLOSE to the channel by recipient id', async () => {
    const channelDataPacket = new SshWriter()
      .byte(SSH_MSG_CHANNEL_DATA)
      .uint32(0) // recipient = local channel 0
      .string(new TextEncoder().encode('hello'))
      .finish();
    const windowAdjustPacket = new SshWriter()
      .byte(SSH_MSG_CHANNEL_WINDOW_ADJUST)
      .uint32(0)
      .uint32(1000)
      .finish();
    const eofPacket = new SshWriter().byte(SSH_MSG_CHANNEL_EOF).uint32(0).finish();
    const closePacket = new SshWriter().byte(SSH_MSG_CHANNEL_CLOSE).uint32(0).finish();

    const { client } = newClient([channelDataPacket, windowAdjustPacket, eofPacket, closePacket]);

    const channel = new SshChannel({
      send: async () => {},
      localChannel: 0,
      remoteChannel: 5,
      remoteWindow: 100,
      maxPacket: 1000,
      localWindow: 1000,
    });
    const onData = vi.spyOn(channel, 'onData');
    const onWindowAdjust = vi.spyOn(channel, 'onWindowAdjust');
    const onEof = vi.spyOn(channel, 'onEof');
    const onClose = vi.spyOn(channel, 'onClose');

    (client as any).channels.set(0, channel);

    // readLoop runs until the scripted packets are exhausted and the stream
    // throws (connection closed); it catches that and returns.
    await (client as any).readLoop();

    expect(onData).toHaveBeenCalledTimes(1);
    expect(Array.from(onData.mock.calls[0][0] as Uint8Array)).toEqual(Array.from(new TextEncoder().encode('hello')));
    expect(onWindowAdjust).toHaveBeenCalledWith(1000);
    expect(onEof).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    // CHANNEL_CLOSE dispatch removes the channel from the map.
    expect((client as any).channels.has(0)).toBe(false);
  });

  it('replies failure to a want_reply GLOBAL_REQUEST seen mid-readLoop', async () => {
    const { client, socket } = newClient([globalRequestPacket(true)]);
    await (client as any).readLoop();
    expect(socket.sentBytes.length).toBe(1);
    const sentPayload = decodeNoneCipherPacket(socket.sentBytes[0]);
    expect(sentPayload[0]).toBe(SSH_MSG_REQUEST_FAILURE);
  });

  it('tears down all channels on DISCONNECT', async () => {
    const { client } = newClient([disconnectPacket(11, 'shutting down')]);
    const channel = new SshChannel({
      send: async () => {},
      localChannel: 0,
      remoteChannel: 5,
      remoteWindow: 100,
      maxPacket: 1000,
      localWindow: 1000,
    });
    const onClose = vi.spyOn(channel, 'onClose');
    (client as any).channels.set(0, channel);

    await (client as any).readLoop();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect((client as any).channels.size).toBe(0);
  });
});

describe('SshClient cipher swap at NEWKEYS', () => {
  it('send()/recv() use the swapped GcmCipher once installed, and seq numbers keep incrementing', async () => {
    const { client } = newClient([]);

    expect((client as any).c2sSeq).toBe(0);

    // Simulate what connect() does after NEWKEYS: install GCM ciphers.
    const key = new Uint8Array(32).fill(7);
    const iv = new Uint8Array(12);
    iv.set([9, 9, 9, 9], 0);
    (client as any).c2sCipher = new GcmCipher(key, iv.slice());

    await (client as any).send(new SshWriter().byte(1).finish());
    expect((client as any).c2sSeq).toBe(1);

    await (client as any).send(new SshWriter().byte(2).finish());
    expect((client as any).c2sSeq).toBe(2);

    expect((client as any).c2sCipher).toBeInstanceOf(GcmCipher);
  });
});

describe('SshClient.openSubsystem — early CHANNEL_WINDOW_ADJUST regression', () => {
  it('applies a CHANNEL_WINDOW_ADJUST that arrives before CHANNEL_SUCCESS, instead of dropping it', async () => {
    // Server opens the channel with a ZERO initial window, then immediately grants
    // the real window via WINDOW_ADJUST *before* replying to the subsystem request.
    // That WINDOW_ADJUST arrives while openSubsystem() is inside
    // recvExpecting(CHANNEL_SUCCESS) — it must be routed to the channel, not dropped.
    const openConfirmation = new SshWriter()
      .byte(SSH_MSG_CHANNEL_OPEN_CONFIRMATION)
      .uint32(0) // recipient (our local channel 0)
      .uint32(0) // sender (server's channel id)
      .uint32(0) // window = 0
      .uint32(32768) // maxPacket
      .finish();
    const earlyWindowAdjust = new SshWriter()
      .byte(SSH_MSG_CHANNEL_WINDOW_ADJUST)
      .uint32(0) // recipient = our local channel 0
      .uint32(2097152) // bytesToAdd
      .finish();
    const subsystemSuccess = new SshWriter().byte(SSH_MSG_CHANNEL_SUCCESS).uint32(0).finish();

    const { client } = newClient([openConfirmation, earlyWindowAdjust, subsystemSuccess]);

    const chan = await client.openSubsystem('sftp');

    // The key assertion: the early WINDOW_ADJUST reached the channel rather
    // than being silently dropped by recvExpecting's non-matching-message path.
    expect((chan as any).remoteWindow).toBe(2097152);
  });

  it('regression guard: a write after open does not deadlock now that the grant was applied', async () => {
    const openConfirmation = new SshWriter()
      .byte(SSH_MSG_CHANNEL_OPEN_CONFIRMATION)
      .uint32(0)
      .uint32(0)
      .uint32(0) // window = 0
      .uint32(32768)
      .finish();
    const earlyWindowAdjust = new SshWriter().byte(SSH_MSG_CHANNEL_WINDOW_ADJUST).uint32(0).uint32(2097152).finish();
    const subsystemSuccess = new SshWriter().byte(SSH_MSG_CHANNEL_SUCCESS).uint32(0).finish();

    const { client, socket } = newClient([openConfirmation, earlyWindowAdjust, subsystemSuccess]);
    const chan = await client.openSubsystem('sftp');

    const sentBeforeWrite = socket.sentBytes.length;
    // If the grant had been dropped (the bug), remoteWindow would still be 0
    // and this write would hang forever waiting on a WINDOW_ADJUST that will
    // never come — so a bounded race against a timeout proves it didn't hang.
    const wroteInTime = await Promise.race([
      chan.write(new Uint8Array(10)).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 200)),
    ]);
    expect(wroteInTime).toBe(true);
    expect(socket.sentBytes.length).toBeGreaterThan(sentBeforeWrite);
  });
});

/** Decode a single wire-framed none-cipher packet back to its payload, for asserting on client-sent bytes. */
function decodeNoneCipherPacket(wire: Uint8Array): Uint8Array {
  const packetLength = new DataView(wire.buffer, wire.byteOffset, 4).getUint32(0);
  const paddingLength = wire[4];
  const payloadLength = packetLength - 1 - paddingLength;
  return wire.subarray(5, 5 + payloadLength);
}
