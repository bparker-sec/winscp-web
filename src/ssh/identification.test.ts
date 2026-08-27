import { describe, it, expect } from 'vitest';
import { ByteStream, type RawSocket } from '../net/ByteStream';
import { base64Encode } from '../net/base64';
import { exchangeIdentification, CLIENT_ID } from './identification';

/** Fake socket that hands out preloaded receive() chunks and records sends. */
class FakeSocket implements RawSocket {
  sentBytes: Uint8Array[] = [];
  closed = false;
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
  async close() {
    this.closed = true;
  }
}

function textChunk(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe('exchangeIdentification', () => {
  it('skips pre-banner lines and returns the SSH- line as serverId', async () => {
    const sock = new FakeSocket([textChunk('hello\r\nSSH-2.0-OpenSSH_9.2\r\n')]);
    const stream = new ByteStream(sock);
    const result = await exchangeIdentification(stream);
    expect(result.serverId).toBe('SSH-2.0-OpenSSH_9.2');
    expect(result.clientId).toBe(CLIENT_ID);
  });

  it('accepts a banner line with no preamble', async () => {
    const sock = new FakeSocket([textChunk('SSH-2.0-libssh_0.9.6\r\n')]);
    const stream = new ByteStream(sock);
    const result = await exchangeIdentification(stream);
    expect(result.serverId).toBe('SSH-2.0-libssh_0.9.6');
  });

  it('writes CLIENT_ID + CRLF to the stream', async () => {
    const sock = new FakeSocket([textChunk('SSH-2.0-OpenSSH_9.2\r\n')]);
    const stream = new ByteStream(sock);
    await exchangeIdentification(stream);
    const sent = Buffer.concat(sock.sentBytes.map((b) => Buffer.from(b))).toString('utf8');
    expect(sent).toBe(CLIENT_ID + '\r\n');
  });

  it('throws after too many non-SSH- lines (guards against unbounded preamble)', async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `filler ${i}`).join('\r\n') + '\r\n';
    const sock = new FakeSocket([textChunk(lines)]);
    const stream = new ByteStream(sock);
    await expect(exchangeIdentification(stream)).rejects.toThrow();
  });
});
