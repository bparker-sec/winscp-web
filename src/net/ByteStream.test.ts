import { describe, it, expect } from 'vitest';
import { ByteStream, type RawSocket } from './ByteStream';
import { base64Encode } from './base64';

/** Fake socket that hands out preloaded receive() chunks and records sends. */
class FakeSocket implements RawSocket {
  sent: number[] = [];
  closed = false;
  private queue: (string | null)[];
  constructor(chunks: Uint8Array[]) {
    this.queue = chunks.map((c) => base64Encode(c));
  }
  async send() {
    this.sent.push(1);
    return 1;
  }
  async receive() {
    return this.queue.length ? this.queue.shift()! : null;
  }
  async close() {
    this.closed = true;
  }
}

describe('ByteStream', () => {
  it('readExactly assembles across multiple receive() chunks', async () => {
    const s = new ByteStream(new FakeSocket([Uint8Array.of(1, 2), Uint8Array.of(3), Uint8Array.of(4, 5, 6)]));
    expect(Array.from(await s.readExactly(4))).toEqual([1, 2, 3, 4]);
    expect(Array.from(await s.readExactly(2))).toEqual([5, 6]);
  });

  it('readExactly throws when the connection closes early', async () => {
    const s = new ByteStream(new FakeSocket([Uint8Array.of(1)]));
    await expect(s.readExactly(4)).rejects.toThrow();
  });

  it('readLine returns a CRLF-terminated line without the terminator', async () => {
    const line = new TextEncoder().encode('SSH-2.0-Server\r\nrest');
    const s = new ByteStream(new FakeSocket([line]));
    expect(await s.readLine()).toBe('SSH-2.0-Server');
    // the leftover "rest" stays buffered for the next read
    expect(Array.from(await s.readExactly(4))).toEqual(Array.from(new TextEncoder().encode('rest')));
  });

  it('write encodes to base64 and reports failure when the host returns null', async () => {
    const failing: RawSocket = {
      async send() {
        return null;
      },
      async receive() {
        return null;
      },
      async close() {},
    };
    const s = new ByteStream(failing);
    await expect(s.write(Uint8Array.of(1, 2, 3))).rejects.toThrow();
  });
});
