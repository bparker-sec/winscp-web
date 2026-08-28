// SFTP v3 message builders and parsers (RFC draft-ietf-secsh-filexfer-02).
//
// Builders return a COMPLETE SFTP packet including the leading `uint32
// length` prefix (length counts the type byte + body). Parsers operate on a
// packet BODY (the bytes after the type byte, as produced by SftpFramer's
// `{ type, body }`) — callers dispatch on `type` (see constants.ts;
// SSH_FXP_*) to pick the right parser.

import { SshReader, SshWriter } from '../ssh/wire';
import { decodeAttrs, encodeAttrs, type FileAttrs } from './attrs';
import {
  SSH_FXP_CLOSE,
  SSH_FXP_INIT,
  SSH_FXP_LSTAT,
  SSH_FXP_MKDIR,
  SSH_FXP_OPEN,
  SSH_FXP_OPENDIR,
  SSH_FXP_READ,
  SSH_FXP_READDIR,
  SSH_FXP_REALPATH,
  SSH_FXP_REMOVE,
  SSH_FXP_RENAME,
  SSH_FXP_RMDIR,
  SSH_FXP_SETSTAT,
  SSH_FXP_STAT,
  SSH_FXP_WRITE,
} from './constants';

const SFTP_VERSION = 3;

/** Wrap a body writer into a complete SFTP packet: `uint32 length || byte type || body`. */
function packet(type: number, bodyWriter: SshWriter): Uint8Array {
  const body = bodyWriter.finish();
  return new SshWriter().uint32(1 + body.length).byte(type).raw(body).finish();
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export function buildInit(): Uint8Array {
  return packet(SSH_FXP_INIT, new SshWriter().uint32(SFTP_VERSION));
}

export function buildOpen(id: number, path: string, pflags: number, attrs: FileAttrs = {}): Uint8Array {
  const w = new SshWriter().uint32(id).string(path).uint32(pflags).raw(encodeAttrs(attrs));
  return packet(SSH_FXP_OPEN, w);
}

export function buildClose(id: number, handle: Uint8Array): Uint8Array {
  return packet(SSH_FXP_CLOSE, new SshWriter().uint32(id).string(handle));
}

export function buildRead(id: number, handle: Uint8Array, offset: number, length: number): Uint8Array {
  const w = new SshWriter().uint32(id).string(handle).uint64(BigInt(offset)).uint32(length);
  return packet(SSH_FXP_READ, w);
}

export function buildWrite(id: number, handle: Uint8Array, offset: number, data: Uint8Array): Uint8Array {
  const w = new SshWriter().uint32(id).string(handle).uint64(BigInt(offset)).string(data);
  return packet(SSH_FXP_WRITE, w);
}

export function buildOpenDir(id: number, path: string): Uint8Array {
  return packet(SSH_FXP_OPENDIR, new SshWriter().uint32(id).string(path));
}

export function buildRealpath(id: number, path: string): Uint8Array {
  return packet(SSH_FXP_REALPATH, new SshWriter().uint32(id).string(path));
}

export function buildRemove(id: number, path: string): Uint8Array {
  return packet(SSH_FXP_REMOVE, new SshWriter().uint32(id).string(path));
}

export function buildRmdir(id: number, path: string): Uint8Array {
  return packet(SSH_FXP_RMDIR, new SshWriter().uint32(id).string(path));
}

export function buildStat(id: number, path: string): Uint8Array {
  return packet(SSH_FXP_STAT, new SshWriter().uint32(id).string(path));
}

export function buildLstat(id: number, path: string): Uint8Array {
  return packet(SSH_FXP_LSTAT, new SshWriter().uint32(id).string(path));
}

export function buildReadDir(id: number, handle: Uint8Array): Uint8Array {
  return packet(SSH_FXP_READDIR, new SshWriter().uint32(id).string(handle));
}

export function buildMkdir(id: number, path: string, attrs: FileAttrs = {}): Uint8Array {
  const w = new SshWriter().uint32(id).string(path).raw(encodeAttrs(attrs));
  return packet(SSH_FXP_MKDIR, w);
}

export function buildSetstat(id: number, path: string, attrs: FileAttrs): Uint8Array {
  const w = new SshWriter().uint32(id).string(path).raw(encodeAttrs(attrs));
  return packet(SSH_FXP_SETSTAT, w);
}

export function buildRename(id: number, oldPath: string, newPath: string): Uint8Array {
  const w = new SshWriter().uint32(id).string(oldPath).string(newPath);
  return packet(SSH_FXP_RENAME, w);
}

// ---------------------------------------------------------------------------
// Parsers (operate on a packet BODY — bytes after the type byte)
// ---------------------------------------------------------------------------

const utf8Decoder = new TextDecoder();

export function parseVersion(body: Uint8Array): { version: number } {
  const r = new SshReader(body);
  return { version: r.uint32() };
}

export function parseStatus(body: Uint8Array): { id: number; code: number; message: string } {
  const r = new SshReader(body);
  const id = r.uint32();
  const code = r.uint32();
  let message = '';
  if (r.remaining().length > 0) {
    message = utf8Decoder.decode(r.string());
  }
  // language tag (if present) is ignored.
  return { id, code, message };
}

export function parseHandle(body: Uint8Array): { id: number; handle: Uint8Array } {
  const r = new SshReader(body);
  const id = r.uint32();
  const handle = r.string();
  return { id, handle };
}

export function parseData(body: Uint8Array): { id: number; data: Uint8Array } {
  const r = new SshReader(body);
  const id = r.uint32();
  const data = r.string();
  return { id, data };
}

export function parseName(
  body: Uint8Array,
): { id: number; entries: { filename: string; longname: string; attrs: FileAttrs }[] } {
  const r = new SshReader(body);
  const id = r.uint32();
  const count = r.uint32();
  const entries: { filename: string; longname: string; attrs: FileAttrs }[] = [];
  for (let i = 0; i < count; i++) {
    const filename = utf8Decoder.decode(r.string());
    const longname = utf8Decoder.decode(r.string());
    const attrs = decodeAttrs(r);
    entries.push({ filename, longname, attrs });
  }
  return { id, entries };
}

export function parseAttrs(body: Uint8Array): { id: number; attrs: FileAttrs } {
  const r = new SshReader(body);
  const id = r.uint32();
  const attrs = decodeAttrs(r);
  return { id, attrs };
}
