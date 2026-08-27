import { describe, it, expect } from 'vitest';
import { ByteStream, type RawSocket } from '../net/ByteStream';
import { base64Encode } from '../net/base64';
import { NoneCipher, GcmCipher, encodePacket, readPacket } from './packet';

/** Fake socket that hands out preloaded receive() chunks and records sends. */
class FakeSocket implements RawSocket {
  sentBytes: Uint8Array[] = [];
  private queue: (string | null)[];
  constructor(chunks: Uint8Array[]) {
    this.queue = chunks.map((c) => base64Encode(c));
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

function streamOf(bytes: Uint8Array): ByteStream {
  return new ByteStream(new FakeSocket([bytes]));
}

function payloadOf(len: number): Uint8Array {
  const p = new Uint8Array(len);
  for (let i = 0; i < len; i++) p[i] = i & 0xff;
  return p;
}

describe('none-cipher packet round-trip', () => {
  for (const len of [0, 5, 20]) {
    it(`round-trips a payload of length ${len}`, async () => {
      const payload = payloadOf(len);
      const wire = encodePacket(payload, new NoneCipher(), 0);
      const decoded = await readPacket(streamOf(wire), new NoneCipher(), 0);
      expect(Array.from(decoded)).toEqual(Array.from(payload));
    });
  }

  it('satisfies the none-cipher padding invariants', () => {
    for (const len of [0, 1, 5, 8, 20, 100]) {
      const payload = payloadOf(len);
      const wire = encodePacket(payload, new NoneCipher(), 0);
      const packetLength = new DataView(wire.buffer, wire.byteOffset, 4).getUint32(0);
      const paddingLength = wire[4];
      expect((4 + packetLength) % 8).toBe(0);
      expect(paddingLength).toBeGreaterThanOrEqual(4);
      expect(packetLength).toBe(1 + payload.length + paddingLength);
    }
  });
});

describe('gcm-cipher packet round-trip', () => {
  const key = new Uint8Array(32).map((_, i) => i + 1);
  function freshIv() {
    const iv = new Uint8Array(12);
    iv.set([1, 2, 3, 4], 0); // fixed part
    return iv; // counter starts at 0
  }

  it('round-trips a payload and the wire ciphertext differs from plaintext', async () => {
    const payload = new TextEncoder().encode('hello ssh world');
    const sendCipher = new GcmCipher(key, freshIv());
    const wire = encodePacket(payload, sendCipher, 0);

    // wire (post packet_length prefix) must not contain the plaintext payload verbatim
    const wireTail = wire.subarray(4);
    const plainNeedle = Buffer.from(payload).toString('latin1');
    const wireStr = Buffer.from(wireTail).toString('latin1');
    expect(wireStr.includes(plainNeedle)).toBe(false);

    const recvCipher = new GcmCipher(key, freshIv());
    const decoded = await readPacket(streamOf(wire), recvCipher, 0);
    expect(Array.from(decoded)).toEqual(Array.from(payload));
  });

  it('satisfies the gcm padding invariant: (1 + payload + padding) % 16 === 0', () => {
    for (const len of [0, 1, 15, 16, 33]) {
      const payload = payloadOf(len);
      const cipher = new GcmCipher(key, freshIv());
      const wire = encodePacket(payload, cipher, 0);
      const packetLength = new DataView(wire.buffer, wire.byteOffset, 4).getUint32(0);
      expect(packetLength % 16).toBe(0);
      expect(wire.length).toBe(4 + packetLength + 16); // ciphertext + 16-byte tag
    }
  });

  it('throws when a wire byte is tampered with (tag mismatch)', async () => {
    const payload = new TextEncoder().encode('sensitive payload');
    const sendCipher = new GcmCipher(key, freshIv());
    const wire = encodePacket(payload, sendCipher, 0);
    const tampered = wire.slice();
    tampered[tampered.length - 1] ^= 0xff; // flip a byte in the tag

    const recvCipher = new GcmCipher(key, freshIv());
    await expect(readPacket(streamOf(tampered), recvCipher, 0)).rejects.toThrow();
  });

  it('increments the IV after each packet so sequential packets use distinct IVs', async () => {
    const sendCipher = new GcmCipher(key, freshIv());
    const recvCipher = new GcmCipher(key, freshIv());
    const p1 = new TextEncoder().encode('first');
    const p2 = new TextEncoder().encode('second');
    const w1 = encodePacket(p1, sendCipher, 0);
    const w2 = encodePacket(p2, sendCipher, 1);
    const d1 = await readPacket(streamOf(w1), recvCipher, 0);
    const d2 = await readPacket(streamOf(w2), recvCipher, 1);
    expect(Array.from(d1)).toEqual(Array.from(p1));
    expect(Array.from(d2)).toEqual(Array.from(p2));
  });
});
