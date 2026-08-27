import { base64Encode, base64Decode } from './base64';

/** The minimal socket surface ByteStream needs (matches the SDK tcp socket). */
export interface RawSocket {
  send(dataBase64: string): Promise<number | null>;
  receive(): Promise<string | null>;
  close(): Promise<void>;
}

function concat(a: Uint8Array, b: Uint8Array) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * A buffered, binary, pull-based stream over a base64 RawSocket. All SSH framing
 * consumes bytes through readExactly()/readLine(); higher layers never see base64.
 */
export class ByteStream {
  private buf = new Uint8Array(0);

  constructor(private readonly sock: RawSocket) {}

  async write(bytes: Uint8Array): Promise<void> {
    const n = await this.sock.send(base64Encode(bytes));
    if (n === null) throw new Error('TCP send failed (host/socket unavailable).');
  }

  /** Read exactly n bytes, awaiting more from the socket as needed. */
  async readExactly(n: number): Promise<Uint8Array> {
    while (this.buf.length < n) await this.pull();
    const out = this.buf.subarray(0, n).slice();
    this.buf = this.buf.slice(n);
    return out;
  }

  /** Read a single \n-terminated line (used for the SSH identification banner). */
  async readLine(maxLen = 512): Promise<string> {
    for (;;) {
      const nl = this.buf.indexOf(0x0a);
      if (nl >= 0) {
        let end = nl;
        if (end > 0 && this.buf[end - 1] === 0x0d) end -= 1; // strip CR
        const line = new TextDecoder().decode(this.buf.subarray(0, end));
        this.buf = this.buf.slice(nl + 1);
        return line;
      }
      if (this.buf.length > maxLen) throw new Error('Line exceeded maximum length.');
      await this.pull();
    }
  }

  async close(): Promise<void> {
    await this.sock.close();
  }

  private async pull(): Promise<void> {
    const chunkB64 = await this.sock.receive();
    if (chunkB64 === null) throw new Error('TCP connection closed by peer.');
    const chunk = base64Decode(chunkB64);
    if (chunk.length > 0) this.buf = concat(this.buf, chunk);
  }
}
