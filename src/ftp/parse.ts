// Pure, side-effect-free parsers for the FTP control protocol (RFC 959 + the
// MLSD/MLST, EPSV and UTF8 extensions). Everything here is synchronous and
// unit-testable without any socket. The stateful control/data plumbing lives in
// FtpConnection.ts; this module only turns protocol text into structured values.

import { joinPath, type FsEntry } from '../fs/FileSystem';

export interface FtpReply {
  /** The 3-digit reply code, e.g. 220, 226, 550. */
  code: number;
  /** The reply text. For a multiline reply, the lines joined by '\n'. */
  text: string;
  /** Each individual text line (code prefixes stripped). */
  lines: string[];
}

/**
 * Parse a single control line into its numeric code, separator and text.
 * A final line uses `NNN<space>text`; a non-final line of a multiline reply
 * uses `NNN-text`. Continuation lines that do not start with a code return
 * `code: null` and `sep: null`.
 */
export function parseReplyLine(line: string): { code: number | null; sep: ' ' | '-' | null; text: string } {
  const m = /^(\d{3})([ -])(.*)$/.exec(line);
  if (!m) return { code: null, sep: null, text: line };
  return { code: Number(m[1]), sep: m[2] as ' ' | '-', text: m[3] };
}

/**
 * Parse a complete (already-buffered) FTP reply blob into {code, text, lines}.
 * Handles both single-line (`NNN text`) and multiline
 * (`NNN-...\n...\nNNN text`) forms. Used for unit tests; the live path uses the
 * streaming reader in FtpConnection which shares the same rules.
 */
export function parseReply(raw: string): FtpReply {
  const all = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  // Drop a single trailing empty element from a terminating newline.
  if (all.length > 1 && all[all.length - 1] === '') all.pop();
  if (all.length === 0) throw new Error('Empty FTP reply');

  const first = parseReplyLine(all[0]);
  if (first.code === null) throw new Error(`Malformed FTP reply: ${JSON.stringify(raw)}`);
  const code = first.code;
  const lines = [first.text];
  if (first.sep === ' ') return { code, text: first.text, lines };

  // Multiline: collect until a line is `NNN<space>...` with the same code.
  for (let i = 1; i < all.length; i++) {
    const parsed = parseReplyLine(all[i]);
    if (parsed.code === code && parsed.sep === ' ') {
      lines.push(parsed.text);
      return { code, text: lines.join('\n'), lines };
    }
    // Intermediate line: keep raw text, stripping an `NNN-` prefix if present.
    lines.push(all[i].replace(/^\d{3}-/, ''));
  }
  // Unterminated multiline (shouldn't happen on a well-behaved server).
  return { code, text: lines.join('\n'), lines };
}

/** True when a reply code is in the given class, e.g. isCode(reply, 2) for 2xx. */
export function replyClass(code: number): number {
  return Math.floor(code / 100);
}

/**
 * Parse an EPSV (229) reply and return the data port. The reply text contains
 * `(|||port|)` (the first three delimiter chars can be any single character,
 * but are conventionally `|`). For EPSV the data host equals the control host.
 */
export function parseEpsv(text: string): number {
  // The delimiter is whatever char appears right after the '('; match it 3x
  // then capture the port, then the same delimiter and ')'.
  const m = /\((.)\1\1(\d+)\1\)/.exec(text);
  if (!m) throw new Error(`Could not parse EPSV reply: ${text}`);
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid EPSV port: ${text}`);
  }
  return port;
}

/**
 * Parse a PASV (227) reply `h1,h2,h3,h4,p1,p2` into an IPv4 host and port.
 * port = p1*256 + p2.
 */
export function parsePasv(text: string): { host: string; port: number } {
  const m = /(\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3})/.exec(text);
  if (!m) throw new Error(`Could not parse PASV reply: ${text}`);
  const nums = m.slice(1, 7).map(Number);
  if (nums.some((n) => n < 0 || n > 255)) throw new Error(`Invalid PASV octet: ${text}`);
  const host = nums.slice(0, 4).join('.');
  const port = nums[4] * 256 + nums[5];
  if (port <= 0 || port > 65535) throw new Error(`Invalid PASV port: ${text}`);
  return { host, port };
}

/** RFC 1918 / loopback / link-local / unspecified detection for IPv4 dotted quads. */
export function isPrivateIp(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true; // link-local
  return false;
}

/**
 * Choose the host to open the PASV data connection to. Many servers behind NAT
 * advertise a private/wrong IP in the 227 reply; when that happens (or the IP
 * is otherwise unroutable) fall back to the control host we already reached.
 */
export function resolveDataHost(controlHost: string, pasvIp: string): string {
  return isPrivateIp(pasvIp) ? controlHost : pasvIp;
}

/**
 * Parse an MLSD/MLST `modify` fact (`YYYYMMDDHHMMSS[.sss]`, always UTC) into
 * epoch milliseconds, or undefined when malformed.
 */
export function parseModifyTime(s: string): number | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?$/.exec(s.trim());
  if (!m) return undefined;
  const [, y, mo, d, h, mi, sec, frac] = m;
  const ms = frac ? Number(`0.${frac}`) * 1000 : 0;
  const t = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec), ms);
  return Number.isNaN(t) ? undefined : t;
}

/** Split the semicolon-delimited facts of an MLSD/MLST line into a lowercased map. */
export function parseFacts(factsPart: string): Record<string, string> {
  const facts: Record<string, string> = {};
  for (const raw of factsPart.split(';')) {
    if (!raw) continue;
    const eq = raw.indexOf('=');
    if (eq < 0) continue;
    facts[raw.slice(0, eq).toLowerCase()] = raw.slice(eq + 1);
  }
  return facts;
}

/** Map an MLSD `type` fact to an FsEntry kind, or null for the cdir/pdir pseudo-entries. */
export function factsToKind(type: string | undefined): FsEntry['kind'] | null {
  if (!type) return 'file';
  const t = type.toLowerCase();
  if (t === 'cdir' || t === 'pdir') return null;
  if (t === 'dir') return 'dir';
  if (t.startsWith('os.unix=slink') || t === 'link' || t.startsWith('os.unix=symlink')) return 'symlink';
  return 'file';
}

/**
 * Parse a single MLSD data line (`fact1=v1;fact2=v2;... name`) into an FsEntry
 * under `parentPath`. Returns null for `.`/`..`, cdir/pdir, or a malformed line.
 */
export function parseMlsdLine(line: string, parentPath: string): FsEntry | null {
  const trimmed = line.replace(/\r$/, '');
  if (!trimmed) return null;
  const sp = trimmed.indexOf(' ');
  if (sp < 0) return null;
  const factsPart = trimmed.slice(0, sp);
  const name = trimmed.slice(sp + 1);
  if (name === '' || name === '.' || name === '..') return null;
  const facts = parseFacts(factsPart);
  const kind = factsToKind(facts['type']);
  if (kind === null) return null;
  const size = facts['size'] !== undefined ? Number(facts['size']) : undefined;
  const mtime = facts['modify'] ? parseModifyTime(facts['modify']) : undefined;
  const mode = facts['unix.mode'] !== undefined ? parseInt(facts['unix.mode'], 8) : undefined;
  return {
    name,
    path: joinPath(parentPath, name),
    kind,
    size: size !== undefined && Number.isFinite(size) ? size : undefined,
    mtime,
    mode: mode !== undefined && Number.isFinite(mode) ? mode & 0o7777 : undefined,
    raw: line,
  };
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Convert a 9-char `rwxrwxrwx` permission string (with setuid/gid/sticky) to mode bits. */
export function permsToMode(perms: string): number | undefined {
  if (perms.length !== 9) return undefined;
  let mode = 0;
  const trip = [0, 3, 6];
  for (let i = 0; i < 3; i++) {
    const off = trip[i];
    if (perms[off] === 'r') mode |= 4 << ((2 - i) * 3);
    if (perms[off + 1] === 'w') mode |= 2 << ((2 - i) * 3);
    const x = perms[off + 2];
    if (x === 'x' || x === 's' || x === 't') mode |= 1 << ((2 - i) * 3);
  }
  if (perms[2] === 's' || perms[2] === 'S') mode |= 0o4000; // setuid
  if (perms[5] === 's' || perms[5] === 'S') mode |= 0o2000; // setgid
  if (perms[8] === 't' || perms[8] === 'T') mode |= 0o1000; // sticky
  return mode;
}

/**
 * Best-effort parse of a Unix `ls -l` date. `ls` prints either `Mon DD HH:MM`
 * (recent files, no year) or `Mon DD  YYYY` (older files). The server timezone
 * is unknown, so this is approximate; treats time-form dates as the current
 * year, backing off a year if that lands in the future. Returns epoch ms.
 */
export function parseLsDate(mon: string, day: string, yearOrTime: string): number | undefined {
  const month = MONTHS[mon.toLowerCase()];
  if (month === undefined) return undefined;
  const d = Number(day);
  if (!Number.isInteger(d) || d < 1 || d > 31) return undefined;
  if (yearOrTime.includes(':')) {
    const [hh, mm] = yearOrTime.split(':').map(Number);
    if (!Number.isInteger(hh) || !Number.isInteger(mm)) return undefined;
    const now = new Date();
    let year = now.getFullYear();
    let t = new Date(year, month, d, hh, mm).getTime();
    // ls shows a clock time only for files within ~6 months; if we computed a
    // date in the future, it must belong to last year.
    if (t > now.getTime() + 24 * 3600 * 1000) {
      year -= 1;
      t = new Date(year, month, d, hh, mm).getTime();
    }
    return Number.isNaN(t) ? undefined : t;
  }
  const year = Number(yearOrTime);
  if (!Number.isInteger(year)) return undefined;
  const t = new Date(year, month, d).getTime();
  return Number.isNaN(t) ? undefined : t;
}

/**
 * Parse a single Unix-style `ls -l` LIST line into an FsEntry under
 * `parentPath`. Returns null for the `total N` header, `.`/`..`, and any line
 * that does not match the expected layout (e.g. Windows/EPLF dialects).
 */
export function parseListLine(line: string, parentPath: string): FsEntry | null {
  const trimmed = line.replace(/\r$/, '');
  if (!trimmed || /^total\s+\d+\s*$/i.test(trimmed)) return null;
  const m =
    /^([-dlbcps])([rwxsStT-]{9})[.+@]?\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\w{3})\s+(\d+)\s+(\S+)\s+(.+)$/.exec(trimmed);
  if (!m) return null;
  const [, typeCh, perms, sizeStr, mon, day, yearOrTime, rest] = m;
  const kind: FsEntry['kind'] = typeCh === 'd' ? 'dir' : typeCh === 'l' ? 'symlink' : 'file';
  let name = rest;
  if (kind === 'symlink') {
    const arrow = name.indexOf(' -> ');
    if (arrow >= 0) name = name.slice(0, arrow);
  }
  if (name === '' || name === '.' || name === '..') return null;
  const size = Number(sizeStr);
  return {
    name,
    path: joinPath(parentPath, name),
    kind,
    size: Number.isFinite(size) ? size : undefined,
    mtime: parseLsDate(mon, day, yearOrTime),
    mode: permsToMode(perms),
    raw: line,
  };
}

/**
 * Parse the quoted path out of a PWD/MKD (257) reply
 * (`257 "/home/user" is the current directory`). Doubled quotes inside the
 * path are literal quotes per RFC 959.
 */
export function parsePwd(text: string): string | null {
  const m = /"((?:[^"]|"")*)"/.exec(text);
  if (!m) return null;
  return m[1].replace(/""/g, '"');
}

/** Parse a SIZE (213) reply body into a byte count, or undefined if not numeric. */
export function parseSize(text: string): number | undefined {
  const m = /(\d+)/.exec(text.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}
