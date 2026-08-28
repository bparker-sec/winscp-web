import { describe, expect, it } from 'vitest';
import { SftpFramer } from './framing';

function u32(n: number): Uint8Array {
  const a = new Uint8Array(4);
  new DataView(a.buffer).setUint32(0, n);
  return a;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Build a full wire packet: uint32 length || byte type || body. */
function packet(type: number, body: Uint8Array): Uint8Array {
  return concat(u32(1 + body.length), Uint8Array.of(type), body);
}

function queueSource(chunks: Uint8Array[]): () => Promise<Uint8Array> {
  const q = [...chunks];
  return async () => {
    if (q.length === 0) return new Uint8Array(0);
    return q.shift()!;
  };
}

describe('SftpFramer', () => {
  it('reassembles a single packet split across two chunks', async () => {
    const body = new Uint8Array([1, 2, 3, 4, 5]);
    const full = packet(42, body);
    const chunk1 = full.subarray(0, 3); // splits inside the length header
    const chunk2 = full.subarray(3);
    const framer = new SftpFramer(queueSource([chunk1, chunk2]));

    const pkt = await framer.next();
    expect(pkt.type).toBe(42);
    expect(Array.from(pkt.body)).toEqual(Array.from(body));
  });

  it('returns two packets delivered in one chunk via two next() calls', async () => {
    const p1 = packet(1, new Uint8Array([9, 9]));
    const p2 = packet(2, new Uint8Array([7]));
    const framer = new SftpFramer(queueSource([concat(p1, p2)]));

    const first = await framer.next();
    expect(first.type).toBe(1);
    expect(Array.from(first.body)).toEqual([9, 9]);

    const second = await framer.next();
    expect(second.type).toBe(2);
    expect(Array.from(second.body)).toEqual([7]);
  });

  it('throws when the length header exceeds the max packet length', async () => {
    const bad = concat(u32(0xffffffff), Uint8Array.of(1));
    const framer = new SftpFramer(queueSource([bad]));
    await expect(framer.next()).rejects.toThrow();
  });

  it('throws when the source closes (empty chunk) mid-packet', async () => {
    const full = packet(5, new Uint8Array([1, 2, 3]));
    const partial = full.subarray(0, full.length - 1); // withhold the last byte
    const framer = new SftpFramer(queueSource([partial, new Uint8Array(0)]));
    await expect(framer.next()).rejects.toThrow(/closed/i);
  });
});
