// SSH channels (RFC 4254): open + subsystem request + duplex data/window management.
import { SshWriter, SshReader } from './wire';
import {
  SSH_MSG_CHANNEL_OPEN,
  SSH_MSG_CHANNEL_OPEN_CONFIRMATION,
  SSH_MSG_CHANNEL_WINDOW_ADJUST,
  SSH_MSG_CHANNEL_DATA,
  SSH_MSG_CHANNEL_EOF,
  SSH_MSG_CHANNEL_CLOSE,
  SSH_MSG_CHANNEL_REQUEST,
} from './constants';

/** byte CHANNEL_OPEN || string "session" || uint32 senderChannel || uint32 initialWindow || uint32 maxPacket */
export function buildChannelOpenSession(senderChannel: number, initialWindow: number, maxPacket: number): Uint8Array {
  return new SshWriter()
    .byte(SSH_MSG_CHANNEL_OPEN)
    .string('session')
    .uint32(senderChannel)
    .uint32(initialWindow)
    .uint32(maxPacket)
    .finish();
}

/** byte CHANNEL_REQUEST || uint32 recipient || string "subsystem" || boolean wantReply || string subsystem */
export function buildSubsystemRequest(recipientChannel: number, subsystem: string, wantReply: boolean): Uint8Array {
  return new SshWriter()
    .byte(SSH_MSG_CHANNEL_REQUEST)
    .uint32(recipientChannel)
    .string('subsystem')
    .bool(wantReply)
    .string(subsystem)
    .finish();
}

/** byte CHANNEL_DATA || uint32 recipient || string data */
export function buildChannelData(recipient: number, data: Uint8Array): Uint8Array {
  return new SshWriter().byte(SSH_MSG_CHANNEL_DATA).uint32(recipient).string(data).finish();
}

/** byte CHANNEL_WINDOW_ADJUST || uint32 recipient || uint32 bytesToAdd */
export function buildWindowAdjust(recipient: number, bytesToAdd: number): Uint8Array {
  return new SshWriter().byte(SSH_MSG_CHANNEL_WINDOW_ADJUST).uint32(recipient).uint32(bytesToAdd).finish();
}

/** byte CHANNEL_EOF || uint32 recipient */
export function buildChannelEof(recipient: number): Uint8Array {
  return new SshWriter().byte(SSH_MSG_CHANNEL_EOF).uint32(recipient).finish();
}

/** byte CHANNEL_CLOSE || uint32 recipient */
export function buildChannelClose(recipient: number): Uint8Array {
  return new SshWriter().byte(SSH_MSG_CHANNEL_CLOSE).uint32(recipient).finish();
}

export interface ChannelOpenConfirmation {
  recipient: number;
  sender: number;
  window: number;
  maxPacket: number;
}

/** byte CHANNEL_OPEN_CONFIRMATION || uint32 recipient || uint32 sender || uint32 window || uint32 maxPacket */
export function parseChannelOpenConfirmation(payload: Uint8Array): ChannelOpenConfirmation {
  const r = new SshReader(payload);
  const msg = r.byte();
  if (msg !== SSH_MSG_CHANNEL_OPEN_CONFIRMATION) {
    throw new Error(`Expected SSH_MSG_CHANNEL_OPEN_CONFIRMATION (91), got ${msg}.`);
  }
  const recipient = r.uint32();
  const sender = r.uint32();
  const window = r.uint32();
  const maxPacket = r.uint32();
  return { recipient, sender, window, maxPacket };
}

export interface ChannelDataMessage {
  recipient: number;
  data: Uint8Array;
}

/** byte CHANNEL_DATA || uint32 recipient || string data */
export function parseChannelData(payload: Uint8Array): ChannelDataMessage {
  const r = new SshReader(payload);
  const msg = r.byte();
  if (msg !== SSH_MSG_CHANNEL_DATA) {
    throw new Error(`Expected SSH_MSG_CHANNEL_DATA (94), got ${msg}.`);
  }
  const recipient = r.uint32();
  const data = r.string();
  return { recipient, data };
}

export interface WindowAdjustMessage {
  recipient: number;
  bytesToAdd: number;
}

/** byte CHANNEL_WINDOW_ADJUST || uint32 recipient || uint32 bytesToAdd */
export function parseWindowAdjust(payload: Uint8Array): WindowAdjustMessage {
  const r = new SshReader(payload);
  const msg = r.byte();
  if (msg !== SSH_MSG_CHANNEL_WINDOW_ADJUST) {
    throw new Error(`Expected SSH_MSG_CHANNEL_WINDOW_ADJUST (93), got ${msg}.`);
  }
  const recipient = r.uint32();
  const bytesToAdd = r.uint32();
  return { recipient, bytesToAdd };
}

/** Replenish the local window once consumed bytes drop below this fraction of the initial window. */
const WINDOW_REPLENISH_THRESHOLD = 0.5;

export interface SshChannelOptions {
  send: (payload: Uint8Array) => Promise<void>;
  localChannel: number;
  remoteChannel: number;
  remoteWindow: number;
  maxPacket: number;
  localWindow: number;
}

/**
 * A duplex byte interface over a single SSH channel, backed by an injected packet
 * transport (`send`). Inbound data/window-adjust messages are delivered to this
 * instance by an external dispatcher via `onData` / `onWindowAdjust`.
 */
export class SshChannel {
  private readonly send: (payload: Uint8Array) => Promise<void>;
  readonly localChannel: number;
  readonly remoteChannel: number;
  private remoteWindow: number;
  private readonly maxPacket: number;
  private readonly initialLocalWindow: number;
  private localWindow: number;

  private readonly inbound: Uint8Array[] = [];
  private readonly readWaiters: Array<(v: Uint8Array) => void> = [];
  private readonly writeWaiters: Array<() => void> = [];
  private eofReceived = false;
  private closed = false;

  constructor(opts: SshChannelOptions) {
    this.send = opts.send;
    this.localChannel = opts.localChannel;
    this.remoteChannel = opts.remoteChannel;
    this.remoteWindow = opts.remoteWindow;
    this.maxPacket = opts.maxPacket;
    this.initialLocalWindow = opts.localWindow;
    this.localWindow = opts.localWindow;
  }

  /** Split `data` into chunks respecting maxPacket and the remote window, sending CHANNEL_DATA. */
  async write(data: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < data.length) {
      if (this.closed) {
        throw new Error('SshChannel: cannot write, channel is closed.');
      }
      if (this.remoteWindow <= 0) {
        await this.waitForWindow();
        continue;
      }
      const chunkSize = Math.min(this.maxPacket, this.remoteWindow, data.length - offset);
      const chunk = data.subarray(offset, offset + chunkSize);
      this.remoteWindow -= chunkSize;
      await this.send(buildChannelData(this.remoteChannel, chunk));
      offset += chunkSize;
    }
  }

  private waitForWindow(): Promise<void> {
    return new Promise((resolve) => {
      this.writeWaiters.push(resolve);
    });
  }

  /** Called by the dispatcher when a CHANNEL_DATA payload arrives for this channel. */
  onData(data: Uint8Array): void {
    if (data.length > 0) {
      this.inbound.push(data);
      const waiter = this.readWaiters.shift();
      if (waiter) {
        waiter(this.inbound.shift()!);
      }
    }

    this.localWindow -= data.length;
    if (this.localWindow < this.initialLocalWindow * WINDOW_REPLENISH_THRESHOLD) {
      const replenish = this.initialLocalWindow - this.localWindow;
      this.localWindow = this.initialLocalWindow;
      void this.send(buildWindowAdjust(this.remoteChannel, replenish));
    }
  }

  /** Called by the dispatcher when a CHANNEL_WINDOW_ADJUST arrives for this channel. */
  onWindowAdjust(bytesToAdd: number): void {
    this.remoteWindow += bytesToAdd;
    while (this.writeWaiters.length > 0 && this.remoteWindow > 0) {
      const waiter = this.writeWaiters.shift();
      waiter?.();
    }
  }

  /** Called by the dispatcher when CHANNEL_EOF arrives for this channel. */
  onEof(): void {
    this.eofReceived = true;
    // Wake any pending readers so they observe EOF (empty chunk) rather than hang.
    while (this.readWaiters.length > 0) {
      const waiter = this.readWaiters.shift();
      waiter?.(new Uint8Array(0));
    }
  }

  /** Returns the next buffered inbound chunk, awaiting one if none is buffered yet. */
  read(): Promise<Uint8Array> {
    const next = this.inbound.shift();
    if (next) {
      return Promise.resolve(next);
    }
    if (this.eofReceived || this.closed) {
      return Promise.resolve(new Uint8Array(0));
    }
    return new Promise((resolve) => {
      this.readWaiters.push(resolve);
    });
  }

  async eof(): Promise<void> {
    await this.send(buildChannelEof(this.remoteChannel));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.send(buildChannelClose(this.remoteChannel));
    // Unblock anything still waiting.
    while (this.writeWaiters.length > 0) {
      this.writeWaiters.shift()?.();
    }
    while (this.readWaiters.length > 0) {
      this.readWaiters.shift()?.(new Uint8Array(0));
    }
  }
}
