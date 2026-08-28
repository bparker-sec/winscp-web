// SFTP v3 ATTRS codec.

import { SshReader, SshWriter } from '../ssh/wire';
import {
  SSH_FILEXFER_ATTR_ACMODTIME,
  SSH_FILEXFER_ATTR_EXTENDED,
  SSH_FILEXFER_ATTR_PERMISSIONS,
  SSH_FILEXFER_ATTR_SIZE,
  SSH_FILEXFER_ATTR_UIDGID,
} from './constants';

export interface FileAttrs {
  size?: number;
  uid?: number;
  gid?: number;
  permissions?: number;
  atime?: number;
  mtime?: number;
}

/**
 * Encode a FileAttrs into an SFTP ATTRS blob.
 *
 * ACMODTIME (atime+mtime) is a single flag covering both fields per the
 * protocol, so it is only set when BOTH atime and mtime are present on the
 * input; if only one of them is present, it is silently omitted (neither is
 * written) rather than fabricating the other.
 */
export function encodeAttrs(a: FileAttrs): Uint8Array {
  let flags = 0;
  if (a.size !== undefined) flags |= SSH_FILEXFER_ATTR_SIZE;
  if (a.uid !== undefined && a.gid !== undefined) flags |= SSH_FILEXFER_ATTR_UIDGID;
  if (a.permissions !== undefined) flags |= SSH_FILEXFER_ATTR_PERMISSIONS;
  const hasAcModTime = a.atime !== undefined && a.mtime !== undefined;
  if (hasAcModTime) flags |= SSH_FILEXFER_ATTR_ACMODTIME;

  const w = new SshWriter();
  w.uint32(flags);
  if (flags & SSH_FILEXFER_ATTR_SIZE) w.uint64(BigInt(a.size!));
  if (flags & SSH_FILEXFER_ATTR_UIDGID) {
    w.uint32(a.uid!);
    w.uint32(a.gid!);
  }
  if (flags & SSH_FILEXFER_ATTR_PERMISSIONS) w.uint32(a.permissions!);
  if (flags & SSH_FILEXFER_ATTR_ACMODTIME) {
    w.uint32(a.atime!);
    w.uint32(a.mtime!);
  }
  return w.finish();
}

/** Decode an ATTRS blob from a reader positioned at its start. */
export function decodeAttrs(r: SshReader): FileAttrs {
  const flags = r.uint32();
  const out: FileAttrs = {};
  if (flags & SSH_FILEXFER_ATTR_SIZE) out.size = Number(r.uint64());
  if (flags & SSH_FILEXFER_ATTR_UIDGID) {
    out.uid = r.uint32();
    out.gid = r.uint32();
  }
  if (flags & SSH_FILEXFER_ATTR_PERMISSIONS) out.permissions = r.uint32();
  if (flags & SSH_FILEXFER_ATTR_ACMODTIME) {
    out.atime = r.uint32();
    out.mtime = r.uint32();
  }
  if (flags & SSH_FILEXFER_ATTR_EXTENDED) {
    const count = r.uint32();
    for (let i = 0; i < count; i++) {
      r.string(); // extension type
      r.string(); // extension data
    }
  }
  return out;
}
