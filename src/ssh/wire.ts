// SSH binary wire types (RFC 4251 §5). All multi-byte integers are big-endian.

/** Normalize a big-endian magnitude to an SSH mpint value (two's-complement, positive). */
export function normalizeMpint(magnitude: Uint8Array): Uint8Array {
  let i = 0;
  while (i < magnitude.length && magnitude[i] === 0) i++;
  const trimmed = magnitude.subarray(i);
  if (trimmed.length === 0) return new Uint8Array(0);
  if (trimmed[0] & 0x80) {
    const out = new Uint8Array(trimmed.length + 1);
    out.set(trimmed, 1);
    return out;
  }
  return trimmed.slice();
}

export class SshWriter {
  private parts: Uint8Array[] = [];
  private len = 0;

  private push(b: Uint8Array): void {
    this.parts.push(b);
    this.len += b.length;
  }

  byte(n: number): this {
    this.push(Uint8Array.of(n & 0xff));
    return this;
  }
  bool(b: boolean): this {
    return this.byte(b ? 1 : 0);
  }
  uint32(n: number): this {
    const a = new Uint8Array(4);
    new DataView(a.buffer).setUint32(0, n >>> 0);
    this.push(a);
    return this;
  }
  uint64(n: bigint): this {
    const a = new Uint8Array(8);
    new DataView(a.buffer).setBigUint64(0, n);
    this.push(a);
    return this;
  }
  raw(b: Uint8Array): this {
    this.push(b.slice());
    return this;
  }
  string(b: Uint8Array | string): this {
    const bytes = typeof b === 'string' ? new TextEncoder().encode(b) : b;
    this.uint32(bytes.length);
    this.push(bytes.slice());
    return this;
  }
  /** Write a big-endian magnitude as an SSH mpint (normalized, length-prefixed). */
  mpint(magnitude: Uint8Array): this {
    return this.string(normalizeMpint(magnitude));
  }
  nameList(names: string[]): this {
    return this.string(names.join(','));
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.len);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

export class SshReader {
  private off = 0;
  constructor(private readonly buf: Uint8Array) {}

  private view(): DataView {
    return new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
  }

  byte(): number {
    return this.buf[this.off++];
  }
  bool(): boolean {
    return this.byte() !== 0;
  }
  uint32(): number {
    const v = this.view().getUint32(this.off);
    this.off += 4;
    return v;
  }
  uint64(): bigint {
    const v = this.view().getBigUint64(this.off);
    this.off += 8;
    return v;
  }
  bytes(n: number): Uint8Array {
    const b = this.buf.subarray(this.off, this.off + n).slice();
    this.off += n;
    return b;
  }
  string(): Uint8Array {
    return this.bytes(this.uint32());
  }
  nameList(): string[] {
    const s = new TextDecoder().decode(this.string());
    return s.length === 0 ? [] : s.split(',');
  }
  remaining(): Uint8Array {
    return this.buf.subarray(this.off).slice();
  }
  get offset(): number {
    return this.off;
  }
}
