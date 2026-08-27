import { describe, it, expect, vi } from 'vitest';
import { SshWriter, SshReader } from './wire';
import {
  buildChannelOpenSession,
  buildSubsystemRequest,
  buildChannelData,
  buildWindowAdjust,
  buildChannelEof,
  buildChannelClose,
  parseChannelOpenConfirmation,
  parseChannelData,
  parseWindowAdjust,
  SshChannel,
} from './channel';
import {
  SSH_MSG_CHANNEL_OPEN,
  SSH_MSG_CHANNEL_OPEN_CONFIRMATION,
  SSH_MSG_CHANNEL_REQUEST,
  SSH_MSG_CHANNEL_DATA,
  SSH_MSG_CHANNEL_WINDOW_ADJUST,
  SSH_MSG_CHANNEL_EOF,
  SSH_MSG_CHANNEL_CLOSE,
} from './constants';

describe('buildChannelOpenSession', () => {
  it('produces exact bytes', () => {
    const payload = buildChannelOpenSession(3, 2097152, 32768);
    const r = new SshReader(payload);
    expect(r.byte()).toBe(SSH_MSG_CHANNEL_OPEN);
    expect(new TextDecoder().decode(r.string())).toBe('session');
    expect(r.uint32()).toBe(3);
    expect(r.uint32()).toBe(2097152);
    expect(r.uint32()).toBe(32768);
  });
});

describe('buildSubsystemRequest', () => {
  it('produces exact bytes', () => {
    const payload = buildSubsystemRequest(7, 'sftp', true);
    const r = new SshReader(payload);
    expect(r.byte()).toBe(SSH_MSG_CHANNEL_REQUEST);
    expect(r.uint32()).toBe(7);
    expect(new TextDecoder().decode(r.string())).toBe('subsystem');
    expect(r.bool()).toBe(true);
    expect(new TextDecoder().decode(r.string())).toBe('sftp');
  });
});

describe('buildChannelData', () => {
  it('produces exact bytes', () => {
    const data = Uint8Array.of(1, 2, 3, 4);
    const payload = buildChannelData(5, data);
    const r = new SshReader(payload);
    expect(r.byte()).toBe(SSH_MSG_CHANNEL_DATA);
    expect(r.uint32()).toBe(5);
    expect(r.string()).toEqual(data);
  });
});

describe('buildWindowAdjust', () => {
  it('produces exact bytes', () => {
    const payload = buildWindowAdjust(9, 1024);
    const r = new SshReader(payload);
    expect(r.byte()).toBe(SSH_MSG_CHANNEL_WINDOW_ADJUST);
    expect(r.uint32()).toBe(9);
    expect(r.uint32()).toBe(1024);
  });
});

describe('buildChannelEof / buildChannelClose', () => {
  it('produce exact bytes', () => {
    const eof = buildChannelEof(4);
    const eofR = new SshReader(eof);
    expect(eofR.byte()).toBe(SSH_MSG_CHANNEL_EOF);
    expect(eofR.uint32()).toBe(4);

    const close = buildChannelClose(4);
    const closeR = new SshReader(close);
    expect(closeR.byte()).toBe(SSH_MSG_CHANNEL_CLOSE);
    expect(closeR.uint32()).toBe(4);
  });
});

describe('parseChannelOpenConfirmation', () => {
  it('round-trips a hand-built confirmation', () => {
    const built = new SshWriter()
      .byte(SSH_MSG_CHANNEL_OPEN_CONFIRMATION)
      .uint32(3)
      .uint32(11)
      .uint32(2097152)
      .uint32(32768)
      .finish();
    expect(parseChannelOpenConfirmation(built)).toEqual({
      recipient: 3,
      sender: 11,
      window: 2097152,
      maxPacket: 32768,
    });
  });

  it('rejects the wrong message type', () => {
    const bad = new SshWriter().byte(1).uint32(0).finish();
    expect(() => parseChannelOpenConfirmation(bad)).toThrow();
  });
});

describe('parseChannelData', () => {
  it('round-trips', () => {
    const data = Uint8Array.of(9, 8, 7);
    const built = buildChannelData(2, data);
    expect(parseChannelData(built)).toEqual({ recipient: 2, data });
  });
});

describe('parseWindowAdjust', () => {
  it('round-trips', () => {
    const built = buildWindowAdjust(6, 555);
    expect(parseWindowAdjust(built)).toEqual({ recipient: 6, bytesToAdd: 555 });
  });
});

describe('SshChannel window accounting (outbound)', () => {
  it('sends only what the remote window allows, then flushes the rest after WINDOW_ADJUST', async () => {
    const sent: Uint8Array[] = [];
    const send = vi.fn(async (payload: Uint8Array) => {
      sent.push(payload);
    });

    const channel = new SshChannel({
      send,
      localChannel: 0,
      remoteChannel: 1,
      remoteWindow: 10,
      maxPacket: 32768,
      localWindow: 1000,
    });

    const payload = Uint8Array.from({ length: 25 }, (_, i) => i);
    const writeDone = channel.write(payload);

    // Let the first chunk (limited by the 10-byte remote window) flush.
    await Promise.resolve();
    await Promise.resolve();

    expect(sent.length).toBe(1);
    let msg = parseChannelData(sent[0]);
    expect(msg.data).toEqual(payload.subarray(0, 10));

    // Grant more window; the writer should send the rest.
    channel.onWindowAdjust(15);
    await writeDone;

    const allSentData = sent.map((p) => parseChannelData(p).data);
    const combined = new Uint8Array(allSentData.reduce((n, d) => n + d.length, 0));
    let off = 0;
    for (const d of allSentData) {
      combined.set(d, off);
      off += d.length;
    }
    expect(combined).toEqual(payload);
  });

  it('splits writes larger than maxPacket into multiple CHANNEL_DATA messages', async () => {
    const sent: Uint8Array[] = [];
    const send = vi.fn(async (payload: Uint8Array) => {
      sent.push(payload);
    });
    const channel = new SshChannel({
      send,
      localChannel: 0,
      remoteChannel: 1,
      remoteWindow: 1_000_000,
      maxPacket: 4,
      localWindow: 1000,
    });

    const payload = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9);
    await channel.write(payload);

    expect(sent.length).toBe(3); // 4 + 4 + 1
    const chunks = sent.map((p) => parseChannelData(p).data);
    expect(chunks[0]).toEqual(Uint8Array.of(1, 2, 3, 4));
    expect(chunks[1]).toEqual(Uint8Array.of(5, 6, 7, 8));
    expect(chunks[2]).toEqual(Uint8Array.of(9));
  });
});

describe('SshChannel inbound data + window replenishment', () => {
  it('buffers onData for read() and returns it in order', async () => {
    const send = vi.fn(async () => {});
    const channel = new SshChannel({
      send,
      localChannel: 0,
      remoteChannel: 1,
      remoteWindow: 1000,
      maxPacket: 32768,
      localWindow: 1000,
    });

    channel.onData(Uint8Array.of(1, 2, 3));
    const chunk = await channel.read();
    expect(chunk).toEqual(Uint8Array.of(1, 2, 3));
  });

  it('resolves a pending read() once data arrives', async () => {
    const send = vi.fn(async () => {});
    const channel = new SshChannel({
      send,
      localChannel: 0,
      remoteChannel: 1,
      remoteWindow: 1000,
      maxPacket: 32768,
      localWindow: 1000,
    });

    const readPromise = channel.read();
    channel.onData(Uint8Array.of(42));
    expect(await readPromise).toEqual(Uint8Array.of(42));
  });

  it('sends WINDOW_ADJUST once consumed bytes cross the replenish threshold', () => {
    const sent: Uint8Array[] = [];
    const send = vi.fn(async (payload: Uint8Array) => {
      sent.push(payload);
    });
    const channel = new SshChannel({
      send,
      localChannel: 0,
      remoteChannel: 1,
      remoteWindow: 1000,
      maxPacket: 32768,
      localWindow: 100,
    });

    // Consume 40 bytes: still above the 50% threshold, no adjust yet.
    channel.onData(new Uint8Array(40));
    expect(sent.length).toBe(0);

    // Consume 20 more (total 60 > 50): should trigger a WINDOW_ADJUST.
    channel.onData(new Uint8Array(20));
    expect(sent.length).toBe(1);
    const adjust = parseWindowAdjust(sent[0]);
    expect(adjust.recipient).toBe(1);
    expect(adjust.bytesToAdd).toBe(60);
  });
});

describe('SshChannel eof/close', () => {
  it('eof() and close() send the right messages', async () => {
    const sent: Uint8Array[] = [];
    const send = vi.fn(async (payload: Uint8Array) => {
      sent.push(payload);
    });
    const channel = new SshChannel({
      send,
      localChannel: 0,
      remoteChannel: 3,
      remoteWindow: 1000,
      maxPacket: 32768,
      localWindow: 1000,
    });

    await channel.eof();
    await channel.close();

    expect(sent.length).toBe(2);
    const eofR = new SshReader(sent[0]);
    expect(eofR.byte()).toBe(SSH_MSG_CHANNEL_EOF);
    expect(eofR.uint32()).toBe(3);
    const closeR = new SshReader(sent[1]);
    expect(closeR.byte()).toBe(SSH_MSG_CHANNEL_CLOSE);
    expect(closeR.uint32()).toBe(3);
  });

  it('unblocks a pending read() on close without hanging', async () => {
    const send = vi.fn(async () => {});
    const channel = new SshChannel({
      send,
      localChannel: 0,
      remoteChannel: 1,
      remoteWindow: 1000,
      maxPacket: 32768,
      localWindow: 1000,
    });

    const readPromise = channel.read();
    await channel.close();
    expect(await readPromise).toEqual(new Uint8Array(0));
  });
});
