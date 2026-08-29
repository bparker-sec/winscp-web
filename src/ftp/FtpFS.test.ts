import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// Mock the SDK TCP seam so passive data connections can be scripted without a
// real socket. tcpConnect is the only thing openPassive() reaches out to.
vi.mock('../sdk/tcp', () => ({ tcpConnect: vi.fn() }));

import { tcpConnect } from '../sdk/tcp';
import { ByteStream, type RawSocket } from '../net/ByteStream';
import { base64Encode, base64Decode } from '../net/base64';
import { FsError } from '../fs/FileSystem';
import { FtpClient, ftpError } from './FtpConnection';
import { FtpFS } from './FtpFS';
import {
  parseReply,
  parseReplyLine,
  parseEpsv,
  parsePasv,
  parseMlsdLine,
  parseListLine,
  parsePwd,
  parseModifyTime,
  parseSize,
  permsToMode,
  isPrivateIp,
  resolveDataHost,
} from './parse';

const mockTcpConnect = tcpConnect as unknown as Mock;

/**
 * A scripted RawSocket: receive() hands out preloaded reply/data chunks (encoded
 * to base64), send() records the decoded UTF-8 bytes. Serves as both a control
 * channel and a data connection in these tests.
 */
class ScriptedSocket implements RawSocket {
  sent: string[] = [];
  sentBytes: Uint8Array[] = [];
  closed = false;
  private queue: (string | null)[] = [];

  /** Queue text that receive() will yield as one base64 chunk. */
  push(text: string): this {
    this.queue.push(base64Encode(new TextEncoder().encode(text)));
    return this;
  }

  /** Queue raw bytes (e.g. a listing body) as one chunk. */
  pushBytes(bytes: Uint8Array): this {
    this.queue.push(base64Encode(bytes));
    return this;
  }

  async send(dataB64: string): Promise<number> {
    const bytes = base64Decode(dataB64);
    this.sentBytes.push(bytes);
    this.sent.push(new TextDecoder().decode(bytes));
    return dataB64.length;
  }

  async receive(): Promise<string | null> {
    return this.queue.length ? this.queue.shift()! : null;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function makeClient(control: ScriptedSocket, host = 'ftp.example.com'): FtpClient {
  return new FtpClient(new ByteStream(control), host, control);
}

beforeEach(() => {
  mockTcpConnect.mockReset();
});

// ---------------------------------------------------------------------------
// Pure reply parsing
// ---------------------------------------------------------------------------

describe('parseReplyLine', () => {
  it('parses a final line', () => {
    expect(parseReplyLine('220 Welcome')).toEqual({ code: 220, sep: ' ', text: 'Welcome' });
  });
  it('parses a non-final (dash) line', () => {
    expect(parseReplyLine('220-first')).toEqual({ code: 220, sep: '-', text: 'first' });
  });
  it('returns null code for a bare continuation line', () => {
    expect(parseReplyLine(' more text')).toEqual({ code: null, sep: null, text: ' more text' });
  });
});

describe('parseReply', () => {
  it('parses a single-line reply', () => {
    const r = parseReply('200 Type set to I\r\n');
    expect(r).toEqual({ code: 200, text: 'Type set to I', lines: ['Type set to I'] });
  });

  it('parses a multiline reply and keeps the same closing code', () => {
    const raw = '211-Features:\r\n MLSD\r\n UTF8\r\n211 End\r\n';
    const r = parseReply(raw);
    expect(r.code).toBe(211);
    expect(r.lines).toEqual(['Features:', ' MLSD', ' UTF8', 'End']);
    expect(r.text).toContain('MLSD');
  });

  it('does not terminate on an inner line whose number differs', () => {
    // A body line that merely starts with digits must not close the reply.
    const raw = '250-Start\r\n226 bytes were sent\r\n250 End\r\n';
    const r = parseReply(raw);
    expect(r.code).toBe(250);
    expect(r.lines[r.lines.length - 1]).toBe('End');
  });
});

// ---------------------------------------------------------------------------
// Passive-mode parsing
// ---------------------------------------------------------------------------

describe('parseEpsv', () => {
  it('extracts the port from the (|||port|) form', () => {
    expect(parseEpsv('Entering Extended Passive Mode (|||6446|)')).toBe(6446);
  });
  it('tolerates an alternate delimiter char', () => {
    expect(parseEpsv('OK (!!!1234!)')).toBe(1234);
  });
  it('throws on garbage', () => {
    expect(() => parseEpsv('no port here')).toThrow();
  });
});

describe('parsePasv', () => {
  it('parses host and computes port = p1*256 + p2', () => {
    expect(parsePasv('227 Entering Passive Mode (192,168,1,5,195,80)')).toEqual({
      host: '192.168.1.5',
      port: 195 * 256 + 80,
    });
  });
  it('rejects an out-of-range octet', () => {
    expect(() => parsePasv('(1,2,3,999,4,5)')).toThrow();
  });
});

describe('isPrivateIp / resolveDataHost', () => {
  it('flags RFC1918 and loopback ranges', () => {
    expect(isPrivateIp('10.0.0.1')).toBe(true);
    expect(isPrivateIp('192.168.1.1')).toBe(true);
    expect(isPrivateIp('172.16.5.5')).toBe(true);
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('169.254.1.1')).toBe(true);
    expect(isPrivateIp('8.8.8.8')).toBe(false);
  });
  it('prefers the control host when PASV reports a private IP', () => {
    expect(resolveDataHost('ftp.example.com', '192.168.0.10')).toBe('ftp.example.com');
    expect(resolveDataHost('ftp.example.com', '203.0.113.5')).toBe('203.0.113.5');
  });
});

// ---------------------------------------------------------------------------
// MLSD / LIST / misc parsing
// ---------------------------------------------------------------------------

describe('parseModifyTime', () => {
  it('parses YYYYMMDDHHMMSS as UTC epoch ms', () => {
    expect(parseModifyTime('20240102130405')).toBe(Date.UTC(2024, 0, 2, 13, 4, 5));
  });
  it('returns undefined for malformed input', () => {
    expect(parseModifyTime('nope')).toBeUndefined();
  });
});

describe('parseMlsdLine', () => {
  it('parses a directory entry', () => {
    const e = parseMlsdLine('type=dir;modify=20240101120000; docs', '/home');
    expect(e).toMatchObject({ name: 'docs', path: '/home/docs', kind: 'dir' });
    expect(e!.mtime).toBe(Date.UTC(2024, 0, 1, 12, 0, 0));
  });
  it('parses a file entry with size and unix.mode', () => {
    const e = parseMlsdLine('type=file;size=42;modify=20240102130000;unix.mode=0644; readme.txt', '/home');
    expect(e).toMatchObject({ name: 'readme.txt', kind: 'file', size: 42, mode: 0o644 });
  });
  it('skips cdir/pdir pseudo-entries', () => {
    expect(parseMlsdLine('type=cdir; .', '/home')).toBeNull();
    expect(parseMlsdLine('type=pdir; ..', '/home')).toBeNull();
  });
  it('recognizes a symlink type', () => {
    const e = parseMlsdLine('type=OS.unix=slink:/target;size=7; link', '/home');
    expect(e).toMatchObject({ name: 'link', kind: 'symlink' });
  });
  it('preserves spaces in filenames', () => {
    const e = parseMlsdLine('type=file;size=1; my file.txt', '/home');
    expect(e).toMatchObject({ name: 'my file.txt' });
  });
});

describe('parseListLine (Unix ls -l)', () => {
  it('parses a file line', () => {
    const e = parseListLine('-rw-r--r--   1 owner group      1234 Jan  2 12:00 report.txt', '/d');
    expect(e).toMatchObject({ name: 'report.txt', path: '/d/report.txt', kind: 'file', size: 1234 });
    expect(e!.mode).toBe(0o644);
    expect(e!.mtime).toBeTypeOf('number');
  });
  it('parses a directory line', () => {
    const e = parseListLine('drwxr-xr-x   2 owner group      4096 Jan  1  2023 subdir', '/d');
    expect(e).toMatchObject({ name: 'subdir', kind: 'dir', size: 4096, mode: 0o755 });
  });
  it('parses a symlink and strips the -> target', () => {
    const e = parseListLine('lrwxrwxrwx   1 o g   7 Jan  1 12:00 link -> /real/target', '/d');
    expect(e).toMatchObject({ name: 'link', kind: 'symlink' });
  });
  it('skips the total header and . / ..', () => {
    expect(parseListLine('total 8', '/d')).toBeNull();
    expect(parseListLine('drwxr-xr-x 2 o g 4096 Jan 1 2023 .', '/d')).toBeNull();
  });
  it('returns null for an unrecognized (non ls -l) line', () => {
    expect(parseListLine('12-31-99  01:00PM  <DIR>  winstuff', '/d')).toBeNull();
  });
});

describe('permsToMode', () => {
  it('converts rwx triples', () => {
    expect(permsToMode('rwxr-xr-x')).toBe(0o755);
    expect(permsToMode('rw-r--r--')).toBe(0o644);
  });
  it('handles setuid/setgid/sticky', () => {
    expect(permsToMode('rwsr-xr-x')).toBe(0o4755);
    expect(permsToMode('rwxr-xr-t')).toBe(0o1755);
  });
});

describe('parsePwd / parseSize', () => {
  it('extracts a quoted path', () => {
    expect(parsePwd('257 "/home/user" is the current directory')).toBe('/home/user');
  });
  it('unescapes doubled quotes', () => {
    expect(parsePwd('257 "/a""b" created')).toBe('/a"b');
  });
  it('parses a SIZE reply body', () => {
    // Callers pass the reply text (already code-stripped).
    expect(parseSize('4096')).toBe(4096);
  });
});

// ---------------------------------------------------------------------------
// Scripted control channel (FtpClient)
// ---------------------------------------------------------------------------

describe('FtpClient.readReply over a scripted socket', () => {
  it('reads a single-line reply', async () => {
    const sock = new ScriptedSocket().push('220 Service ready\r\n');
    const client = makeClient(sock);
    const r = await client.readReply();
    expect(r).toEqual({ code: 220, text: 'Service ready', lines: ['Service ready'] });
  });

  it('reads a multiline reply spread across receive chunks', async () => {
    const sock = new ScriptedSocket();
    sock.push('211-Features:\r\n').push(' MLSD\r\n UTF8\r\n').push('211 End\r\n');
    const client = makeClient(sock);
    const r = await client.readReply();
    expect(r.code).toBe(211);
    expect(r.lines).toEqual(['Features:', ' MLSD', ' UTF8', 'End']);
  });

  it('command() writes line + CRLF and returns the reply', async () => {
    const sock = new ScriptedSocket().push('331 Need password\r\n');
    const client = makeClient(sock);
    const r = await client.command('USER bob');
    expect(sock.sent).toEqual(['USER bob\r\n']);
    expect(r.code).toBe(331);
  });

  it('commandExpect throws FsError on an unexpected code', async () => {
    const sock = new ScriptedSocket().push('530 Login incorrect\r\n');
    const client = makeClient(sock);
    await expect(client.commandExpect('PASS x', [230], 'PASS')).rejects.toMatchObject({
      name: 'FsError',
      code: 'permission',
    });
  });

  it('serializes commands issued concurrently (one in flight at a time)', async () => {
    const sock = new ScriptedSocket();
    sock.push('200 a1\r\n').push('200 a2\r\n').push('200 b1\r\n');
    const client = makeClient(sock);
    // Two lock holders race; the second must not interleave into the first.
    const first = client.withLock(async () => {
      await client.command('A1');
      await client.command('A2');
    });
    const second = client.withLock(async () => {
      await client.command('B1');
    });
    await Promise.all([first, second]);
    expect(sock.sent).toEqual(['A1\r\n', 'A2\r\n', 'B1\r\n']);
  });
});

// ---------------------------------------------------------------------------
// FtpFS control-only operations (no data connection needed)
// ---------------------------------------------------------------------------

describe('FtpFS.rename', () => {
  it('sends RNFR then RNTO', async () => {
    const sock = new ScriptedSocket().push('350 Ready\r\n').push('250 Renamed\r\n');
    const fs = new FtpFS(makeClient(sock));
    await fs.rename('/a/old.txt', '/a/new.txt');
    expect(sock.sent).toEqual(['RNFR /a/old.txt\r\n', 'RNTO /a/new.txt\r\n']);
  });

  it('surfaces a rename failure as FsError', async () => {
    const sock = new ScriptedSocket().push('550 No such file\r\n');
    const fs = new FtpFS(makeClient(sock));
    await expect(fs.rename('/a', '/b')).rejects.toMatchObject({ name: 'FsError', code: 'not-found' });
  });
});

describe('FtpFS.mkdir', () => {
  it('succeeds on 257', async () => {
    const sock = new ScriptedSocket().push('257 "/a/new" created\r\n');
    const fs = new FtpFS(makeClient(sock));
    await expect(fs.mkdir('/a/new')).resolves.toBeUndefined();
    expect(sock.sent[0]).toBe('MKD /a/new\r\n');
  });

  it('maps an existing directory (550 then MLST 250) to FsError(exists)', async () => {
    const sock = new ScriptedSocket().push('550 Cannot create\r\n').push('250 present\r\n');
    const fs = new FtpFS(makeClient(sock));
    await expect(fs.mkdir('/a/dup')).rejects.toMatchObject({ name: 'FsError', code: 'exists' });
    expect(sock.sent).toEqual(['MKD /a/dup\r\n', 'MLST /a/dup\r\n']);
  });
});

describe('FtpFS.remove (file)', () => {
  it('stats via MLST then DELEs the file', async () => {
    const sock = new ScriptedSocket();
    sock.push('250-info\r\n type=file;size=3; note.txt\r\n250 End\r\n').push('250 Deleted\r\n');
    const fs = new FtpFS(makeClient(sock));
    await fs.remove('/a/note.txt', false);
    expect(sock.sent).toEqual(['MLST /a/note.txt\r\n', 'DELE /a/note.txt\r\n']);
  });
});

// ---------------------------------------------------------------------------
// FtpFS.list end-to-end with a scripted control + mocked data connection
// ---------------------------------------------------------------------------

describe('FtpFS.list (MLSD happy path)', () => {
  it('CWDs, opens EPSV data, parses MLSD, reads 226', async () => {
    const control = new ScriptedSocket();
    control
      .push('250 CWD ok\r\n')
      .push('229 Entering Extended Passive Mode (|||50000|)\r\n')
      .push('150 Here comes the listing\r\n')
      .push('226 Directory send OK\r\n');

    const dataBody =
      'type=cdir; /pub\r\n' +
      'type=file;size=42;modify=20240102130000; readme.txt\r\n' +
      'type=dir;modify=20240101120000; docs\r\n';
    const dataSock = new ScriptedSocket().pushBytes(new TextEncoder().encode(dataBody));
    mockTcpConnect.mockResolvedValue({ ok: true, socket: dataSock });

    const fs = new FtpFS(makeClient(control));
    const entries = await fs.list('/pub');

    // tcpConnect used the control host (EPSV) and the parsed port.
    expect(mockTcpConnect).toHaveBeenCalledWith('ftp.example.com', 50000);
    // Folders first, then files (sortEntries).
    expect(entries.map((e) => e.name)).toEqual(['docs', 'readme.txt']);
    expect(entries[0]).toMatchObject({ kind: 'dir', path: '/pub/docs' });
    expect(entries[1]).toMatchObject({ kind: 'file', size: 42, path: '/pub/readme.txt' });
    expect(control.sent).toEqual(['CWD /pub\r\n', 'EPSV\r\n', 'MLSD\r\n']);
  });

  it('falls back to LIST when MLSD is unsupported', async () => {
    const control = new ScriptedSocket();
    control
      .push('250 CWD ok\r\n')
      .push('229 Entering Extended Passive Mode (|||50001|)\r\n')
      .push('500 Unknown command\r\n') // MLSD rejected
      .push('229 Entering Extended Passive Mode (|||50002|)\r\n') // second passive for LIST
      .push('150 Opening data\r\n')
      .push('226 Transfer complete\r\n');

    const listBody = '-rw-r--r-- 1 o g 1234 Jan  2 12:00 report.txt\r\n';
    // Two data connections are opened; the first (for MLSD) is closed unused.
    const firstData = new ScriptedSocket();
    const secondData = new ScriptedSocket().pushBytes(new TextEncoder().encode(listBody));
    mockTcpConnect
      .mockResolvedValueOnce({ ok: true, socket: firstData })
      .mockResolvedValueOnce({ ok: true, socket: secondData });

    const fs = new FtpFS(makeClient(control));
    const entries = await fs.list('/pub');

    expect(entries.map((e) => e.name)).toEqual(['report.txt']);
    expect(firstData.closed).toBe(true);
    expect(control.sent).toEqual(['CWD /pub\r\n', 'EPSV\r\n', 'MLSD\r\n', 'EPSV\r\n', 'LIST\r\n']);
  });

  it('maps a missing directory (CWD 550) to FsError(not-found)', async () => {
    const control = new ScriptedSocket().push('550 No such directory\r\n');
    const fs = new FtpFS(makeClient(control));
    await expect(fs.list('/nope')).rejects.toMatchObject({ name: 'FsError', code: 'not-found' });
  });
});

// ---------------------------------------------------------------------------
// FtpFS.openRead / openWrite streaming over a mocked data connection
// ---------------------------------------------------------------------------

describe('FtpFS.openRead', () => {
  it('SIZEs, RETRs and streams the file body to EOF', async () => {
    const control = new ScriptedSocket();
    control
      .push('213 5\r\n')
      .push('229 Entering Extended Passive Mode (|||51000|)\r\n')
      .push('150 Opening BINARY mode\r\n')
      .push('226 Transfer complete\r\n');
    const dataSock = new ScriptedSocket().pushBytes(Uint8Array.of(1, 2, 3, 4, 5));
    mockTcpConnect.mockResolvedValue({ ok: true, socket: dataSock });

    const fs = new FtpFS(makeClient(control));
    const handle = await fs.openRead('/pub/file.bin');
    expect(handle.size).toBe(5);

    const out: number[] = [];
    const buf = new Uint8Array(3);
    for (;;) {
      const n = await handle.read(buf);
      if (n === 0) break;
      for (let i = 0; i < n; i++) out.push(buf[i]);
    }
    await handle.close();
    expect(out).toEqual([1, 2, 3, 4, 5]);
    expect(control.sent).toEqual(['SIZE /pub/file.bin\r\n', 'EPSV\r\n', 'RETR /pub/file.bin\r\n']);
  });
});

describe('FtpFS.openWrite', () => {
  it('STORs and streams chunks, reading 226 on close', async () => {
    const control = new ScriptedSocket();
    control
      .push('229 Entering Extended Passive Mode (|||52000|)\r\n')
      .push('150 Ok to send data\r\n')
      .push('226 Transfer complete\r\n');
    const dataSock = new ScriptedSocket();
    mockTcpConnect.mockResolvedValue({ ok: true, socket: dataSock });

    const fs = new FtpFS(makeClient(control));
    const handle = await fs.openWrite('/pub/up.bin');
    expect(handle.startOffset).toBe(0);
    await handle.write(Uint8Array.of(9, 8, 7));
    await handle.close();

    expect(dataSock.sentBytes).toEqual([Uint8Array.of(9, 8, 7)]);
    expect(control.sent).toEqual(['EPSV\r\n', 'STOR /pub/up.bin\r\n']);
    expect(dataSock.closed).toBe(true);
  });

  it('resume SIZEs the target and REPORTS startOffset via REST', async () => {
    const control = new ScriptedSocket();
    control
      .push('213 100\r\n') // SIZE
      .push('229 Entering Extended Passive Mode (|||52001|)\r\n')
      .push('350 Restarting at 100\r\n') // REST
      .push('150 Ok to send data\r\n')
      .push('226 Transfer complete\r\n');
    const dataSock = new ScriptedSocket();
    mockTcpConnect.mockResolvedValue({ ok: true, socket: dataSock });

    const fs = new FtpFS(makeClient(control));
    const handle = await fs.openWrite('/pub/up.bin', undefined, { resume: true });
    expect(handle.startOffset).toBe(100);
    await handle.close();
    expect(control.sent).toEqual([
      'SIZE /pub/up.bin\r\n',
      'EPSV\r\n',
      'REST 100\r\n',
      'STOR /pub/up.bin\r\n',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

describe('ftpError mapping', () => {
  it('maps 530 -> permission, 550 -> not-found, 552 -> io', () => {
    expect(ftpError({ code: 530, text: 'x', lines: ['x'] }).code).toBe('permission');
    expect(ftpError({ code: 550, text: 'x', lines: ['x'] }).code).toBe('not-found');
    expect(ftpError({ code: 552, text: 'x', lines: ['x'] }).code).toBe('io');
    expect(ftpError({ code: 421, text: 'x', lines: ['x'] }).code).toBe('io');
  });
  it('produces FsError instances', () => {
    expect(ftpError({ code: 530, text: 'x', lines: ['x'] })).toBeInstanceOf(FsError);
  });
});
