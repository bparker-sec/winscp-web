// Async SFTP client: correlates requests/responses by id over an SshChannel.

import { SftpFramer, type SftpPacket } from './framing';
import {
  buildClose,
  buildInit,
  buildLstat,
  buildMkdir,
  buildOpen,
  buildOpenDir,
  buildRead,
  buildReadDir,
  buildRealpath,
  buildRemove,
  buildRename,
  buildRmdir,
  buildSetstat,
  buildStat,
  buildWrite,
  parseAttrs,
  parseData,
  parseHandle,
  parseName,
  parseStatus,
  parseVersion,
} from './protocol';
import type { FileAttrs } from './attrs';
import { SSH_FX_EOF, SSH_FX_OK, SSH_FXP_ATTRS, SSH_FXP_DATA, SSH_FXP_HANDLE, SSH_FXP_NAME, SSH_FXP_STATUS, SSH_FXP_VERSION } from './constants';

/** Structural duplex the SFTP subsystem channel must satisfy. Matches SshChannel. */
export interface SftpChannel {
  write(bytes: Uint8Array): Promise<void>;
  read(): Promise<Uint8Array>;
  close(): Promise<void>;
}

export class SftpError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'SftpError';
  }
}

interface Pending {
  resolve: (pkt: SftpPacket) => void;
  reject: (err: Error) => void;
}

/** Read the leading `uint32 id` from a response body without a full parse. */
function peekId(body: Uint8Array): number {
  return new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0);
}

export class SftpClient {
  private readonly framer: SftpFramer;
  private nextRequestId = 1;
  private readonly pending = new Map<number, Pending>();
  private loopStarted = false;

  constructor(private readonly channel: SftpChannel) {
    this.framer = new SftpFramer(() => this.channel.read());
  }

  private nextId(): number {
    const id = this.nextRequestId;
    this.nextRequestId = (this.nextRequestId + 1) >>> 0;
    if (this.nextRequestId === 0) this.nextRequestId = 1;
    return id;
  }

  async init(): Promise<number> {
    await this.channel.write(buildInit());
    const pkt = await this.framer.next();
    if (pkt.type !== SSH_FXP_VERSION) {
      throw new Error(`SFTP init failed: expected VERSION, got type ${pkt.type}`);
    }
    const { version } = parseVersion(pkt.body);
    if (version < 3) {
      throw new Error(`SFTP server version ${version} is unsupported (require >= 3)`);
    }
    this.startLoop();
    return version;
  }

  private startLoop(): void {
    if (this.loopStarted) return;
    this.loopStarted = true;
    void this.readLoop();
  }

  private async readLoop(): Promise<void> {
    for (;;) {
      let pkt: SftpPacket;
      try {
        pkt = await this.framer.next();
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        for (const waiter of this.pending.values()) waiter.reject(error);
        this.pending.clear();
        return;
      }
      const id = peekId(pkt.body);
      const waiter = this.pending.get(id);
      if (waiter) {
        this.pending.delete(id);
        waiter.resolve(pkt);
      }
      // Unmatched responses (e.g. stray/duplicate ids) are dropped.
    }
  }

  /**
   * Register a pending waiter for `id`, THEN write — the resolver must exist
   * before any response can arrive. If the write itself fails, the pending
   * entry is dropped and THIS request's promise is rejected (never orphaned
   * in `this.pending`), so callers always get a settled promise to await.
   */
  private request(bytes: Uint8Array, id: number): Promise<SftpPacket> {
    return new Promise<SftpPacket>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.channel.write(bytes).catch((err: unknown) => {
        if (this.pending.delete(id)) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  private expectStatus(pkt: SftpPacket): void {
    if (pkt.type !== SSH_FXP_STATUS) {
      throw new Error(`SFTP error: expected STATUS, got type ${pkt.type}`);
    }
    const { code, message } = parseStatus(pkt.body);
    if (code !== SSH_FX_OK) {
      throw new SftpError(code, message || `SFTP status code ${code}`);
    }
  }

  private statusErrorOrUnexpected(pkt: SftpPacket, expectedName: string): never {
    if (pkt.type === SSH_FXP_STATUS) {
      const { code, message } = parseStatus(pkt.body);
      throw new SftpError(code, message || `SFTP status code ${code}`);
    }
    throw new Error(`SFTP error: expected ${expectedName}, got type ${pkt.type}`);
  }

  async open(path: string, pflags: number, attrs: FileAttrs = {}): Promise<Uint8Array> {
    const id = this.nextId();
    const pkt = await this.request(buildOpen(id, path, pflags, attrs), id);
    if (pkt.type === SSH_FXP_HANDLE) return parseHandle(pkt.body).handle;
    this.statusErrorOrUnexpected(pkt, 'HANDLE');
  }

  /** SFTP CLOSE for a file/dir handle (from `open`/`opendir`). */
  async closeHandle(handle: Uint8Array): Promise<void> {
    const id = this.nextId();
    const pkt = await this.request(buildClose(id, handle), id);
    this.expectStatus(pkt);
  }

  /** Tears down the whole client: closes the channel and rejects any still-pending requests. */
  async close(): Promise<void> {
    await this.channel.close();
    const error = new Error('SFTP client closed');
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }

  async read(handle: Uint8Array, offset: number, length: number): Promise<Uint8Array | null> {
    const id = this.nextId();
    const pkt = await this.request(buildRead(id, handle, offset, length), id);
    if (pkt.type === SSH_FXP_DATA) return parseData(pkt.body).data;
    if (pkt.type === SSH_FXP_STATUS) {
      const { code, message } = parseStatus(pkt.body);
      if (code === SSH_FX_EOF) return null;
      throw new SftpError(code, message || `SFTP status code ${code}`);
    }
    throw new Error(`SFTP error: expected DATA, got type ${pkt.type}`);
  }

  async write(handle: Uint8Array, offset: number, data: Uint8Array): Promise<void> {
    const id = this.nextId();
    const pkt = await this.request(buildWrite(id, handle, offset, data), id);
    this.expectStatus(pkt);
  }

  async opendir(path: string): Promise<Uint8Array> {
    const id = this.nextId();
    const pkt = await this.request(buildOpenDir(id, path), id);
    if (pkt.type === SSH_FXP_HANDLE) return parseHandle(pkt.body).handle;
    this.statusErrorOrUnexpected(pkt, 'HANDLE');
  }

  async readdir(
    handle: Uint8Array,
  ): Promise<{ filename: string; longname: string; attrs: FileAttrs }[] | null> {
    const id = this.nextId();
    const pkt = await this.request(buildReadDir(id, handle), id);
    if (pkt.type === SSH_FXP_NAME) return parseName(pkt.body).entries;
    if (pkt.type === SSH_FXP_STATUS) {
      const { code, message } = parseStatus(pkt.body);
      if (code === SSH_FX_EOF) return null;
      throw new SftpError(code, message || `SFTP status code ${code}`);
    }
    throw new Error(`SFTP error: expected NAME, got type ${pkt.type}`);
  }

  async remove(path: string): Promise<void> {
    const id = this.nextId();
    const pkt = await this.request(buildRemove(id, path), id);
    this.expectStatus(pkt);
  }

  async mkdir(path: string, attrs: FileAttrs = {}): Promise<void> {
    const id = this.nextId();
    const pkt = await this.request(buildMkdir(id, path, attrs), id);
    this.expectStatus(pkt);
  }

  async rmdir(path: string): Promise<void> {
    const id = this.nextId();
    const pkt = await this.request(buildRmdir(id, path), id);
    this.expectStatus(pkt);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const id = this.nextId();
    const pkt = await this.request(buildRename(id, oldPath, newPath), id);
    this.expectStatus(pkt);
  }

  async setstat(path: string, attrs: FileAttrs): Promise<void> {
    const id = this.nextId();
    const pkt = await this.request(buildSetstat(id, path, attrs), id);
    this.expectStatus(pkt);
  }

  async stat(path: string): Promise<FileAttrs> {
    const id = this.nextId();
    const pkt = await this.request(buildStat(id, path), id);
    if (pkt.type === SSH_FXP_ATTRS) return parseAttrs(pkt.body).attrs;
    this.statusErrorOrUnexpected(pkt, 'ATTRS');
  }

  async lstat(path: string): Promise<FileAttrs> {
    const id = this.nextId();
    const pkt = await this.request(buildLstat(id, path), id);
    if (pkt.type === SSH_FXP_ATTRS) return parseAttrs(pkt.body).attrs;
    this.statusErrorOrUnexpected(pkt, 'ATTRS');
  }

  async realpath(path: string): Promise<string> {
    const id = this.nextId();
    const pkt = await this.request(buildRealpath(id, path), id);
    if (pkt.type === SSH_FXP_NAME) {
      const { entries } = parseName(pkt.body);
      if (entries.length === 0) throw new Error('SFTP realpath: NAME response had no entries');
      return entries[0].filename;
    }
    this.statusErrorOrUnexpected(pkt, 'NAME');
  }
}
