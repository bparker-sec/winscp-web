// SFTP packet reassembly over an async chunk source (e.g. SshChannel.read).
//
// Every SFTP packet on the wire is:
//   uint32 length || byte type || <body, length-1 bytes>
// where `length` counts the type byte plus the body. Channel reads deliver
// arbitrary chunk boundaries, so this buffers chunks and slices out complete
// packets.

/** Returns the next chunk of bytes from the underlying transport, or an
 * empty array at EOF / on channel close. */
export type ChunkSource = () => Promise<Uint8Array>;

export interface SftpPacket {
  type: number;
  body: Uint8Array;
}

// Generous cap well above SFTP's typical 256KiB payload ceiling, to guard
// against a corrupt/hostile length header without limiting real traffic.
const MAX_PACKET_LENGTH = 4 * 1024 * 1024;

export class SftpFramer {
  private buffer = new Uint8Array(0);

  constructor(private readonly source: ChunkSource) {}

  private append(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    const next = new Uint8Array(this.buffer.length + chunk.length);
    next.set(this.buffer, 0);
    next.set(chunk, this.buffer.length);
    this.buffer = next;
  }

  /** Read and return the next complete SFTP packet, buffering chunks as needed. */
  async next(): Promise<SftpPacket> {
    // Ensure we have the 4-byte length header.
    while (this.buffer.length < 4) {
      const chunk = await this.source();
      if (chunk.length === 0) {
        throw new Error('SFTP stream closed: channel ended while waiting for a packet header');
      }
      this.append(chunk);
    }

    const length = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength).getUint32(0);
    if (length < 1 || length > MAX_PACKET_LENGTH) {
      throw new Error(`SFTP stream error: packet length ${length} exceeds maximum ${MAX_PACKET_LENGTH}`);
    }

    const total = 4 + length;
    while (this.buffer.length < total) {
      const chunk = await this.source();
      if (chunk.length === 0) {
        throw new Error('SFTP stream closed: channel ended mid-packet');
      }
      this.append(chunk);
    }

    const type = this.buffer[4];
    const body = this.buffer.subarray(5, total).slice();
    this.buffer = this.buffer.subarray(total).slice();
    return { type, body };
  }
}
