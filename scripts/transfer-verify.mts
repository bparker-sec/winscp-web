// Live transfer round-trip verification harness (DEV TOOL — not part of the app bundle).
//
// Drives the REAL transfer engine (transferFile from src/transfer/engine.ts) over a
// live SSH/SFTP server: an in-memory MockFS stands in for "local" (OneDrive in the
// real app), and a real SftpFS talks to the live server over a Node TCP socket
// (mirroring scripts/sftp-verify.mts). Uploads a known-content file, downloads it
// back into a second MockFS, and byte-compares the round trip.
//
// Run:  npx tsx scripts/transfer-verify.mts
// Env:  SSH_HOST (required), SSH_PORT (default 22), SSH_USER (required),
//       SSH_KEY  (path to an unencrypted OpenSSH ed25519 private key; required)
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { ByteStream, type RawSocket } from '../src/net/ByteStream.ts';
import { SshClient } from '../src/ssh/SshClient.ts';
import { parseOpenSshPrivateKey } from '../src/ssh/privatekey.ts';
import { SftpClient } from '../src/sftp/SftpClient.ts';
import { SftpFS } from '../src/sftp/SftpFS.ts';
import { transferFile } from '../src/transfer/engine.ts';
import { FsError, type FileSystem, type ReadHandle, type WriteHandle } from '../src/fs/FileSystem.ts';

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var ${name}`);
    process.exit(2);
  }
  return v;
}

const HOST = reqEnv('SSH_HOST');
const PORT = parseInt(process.env.SSH_PORT ?? '22', 10);
const USER = reqEnv('SSH_USER');
const KEYPATH = reqEnv('SSH_KEY');

/** Adapt a Node net.Socket to the RawSocket (base64 send/receive) interface. */
function nodeRawSocket(host: string, port: number): Promise<RawSocket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host);
    const chunks: Buffer[] = [];
    let waiter: ((v: string | null) => void) | null = null;
    let closed = false;
    let settled = false;
    sock.on('data', (d: Buffer) => {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(d.toString('base64'));
      } else {
        chunks.push(d);
      }
    });
    sock.on('close', () => {
      closed = true;
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(null);
      }
    });
    sock.on('error', (e: Error) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
    sock.on('connect', () => {
      settled = true;
      resolve({
        async send(b64: string) {
          sock.write(Buffer.from(b64, 'base64'));
          return b64.length;
        },
        async receive() {
          if (chunks.length) return chunks.shift()!.toString('base64');
          if (closed) return null;
          return new Promise<string | null>((res) => {
            waiter = res;
          });
        },
        async close() {
          sock.destroy();
        },
      });
    });
  });
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * A tiny single-file in-memory FileSystem, minimal enough to stand in for
 * "local" (OneDrive) on one side of the transfer engine. Only the members
 * transferFile() actually calls are implemented meaningfully.
 */
class SingleFileMockFS implements FileSystem {
  readonly kind = 'mock' as const;
  readonly label: string;
  private files = new Map<string, Uint8Array>();

  constructor(label: string) {
    this.label = label;
  }

  seed(path: string, data: Uint8Array): void {
    this.files.set(path, data);
  }

  async list(): Promise<never[]> {
    return [];
  }

  async stat(path: string) {
    const data = this.files.get(path);
    if (!data) throw new FsError('not-found', `No such path: ${path}`);
    return { name: path.slice(path.lastIndexOf('/') + 1), path, kind: 'file' as const, size: data.byteLength };
  }

  async mkdir(): Promise<void> {
    throw new FsError('unsupported', 'mkdir not supported');
  }

  async rename(): Promise<void> {
    throw new FsError('unsupported', 'rename not supported');
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async move(): Promise<void> {
    throw new FsError('unsupported', 'move not supported');
  }

  async openRead(path: string): Promise<ReadHandle> {
    const data = this.files.get(path);
    if (!data) throw new FsError('not-found', `No such path: ${path}`);
    let offset = 0;
    return {
      size: data.byteLength,
      async read(into: Uint8Array): Promise<number> {
        if (offset >= data.byteLength) return 0;
        const n = Math.min(into.byteLength, data.byteLength - offset);
        into.set(data.subarray(offset, offset + n));
        offset += n;
        return n;
      },
      async close() {},
    };
  }

  async openWrite(path: string): Promise<WriteHandle> {
    const chunks: Uint8Array[] = [];
    const files = this.files;
    return {
      async write(chunk: Uint8Array) {
        chunks.push(chunk.slice());
      },
      async close() {
        const total = chunks.reduce((n, c) => n + c.byteLength, 0);
        const data = new Uint8Array(total);
        let o = 0;
        for (const c of chunks) {
          data.set(c, o);
          o += c.byteLength;
        }
        files.set(path, data);
      },
      async abort() {
        chunks.length = 0;
      },
    };
  }

  read(path: string): Uint8Array {
    const data = this.files.get(path);
    if (!data) throw new Error(`Not seeded: ${path}`);
    return data;
  }
}

async function main(): Promise<void> {
  console.log(`Connecting to ${USER}@${HOST}:${PORT} ...`);
  const raw = await nodeRawSocket(HOST, PORT);
  const stream = new ByteStream(raw);
  const ssh = new SshClient(stream, { host: HOST, port: PORT });

  const { fingerprint } = await ssh.connect((info) => {
    console.log(`  host key ${info.status}: ${info.fingerprint}`);
    return true; // trust-on-first-use for this verification run
  });
  console.log(`✓ kex + host-key verify OK  (${fingerprint})`);

  const key = parseOpenSshPrivateKey(readFileSync(KEYPATH, 'utf8'));
  await ssh.authenticate({
    username: USER,
    privateKey: { seed: key.seed, publicKey: key.publicKey },
  });
  console.log('✓ ed25519 publickey auth OK');

  const channel = await ssh.openSubsystem('sftp');
  const client = new SftpClient(channel);
  const version = await client.init();
  console.log(`✓ SFTP init OK  (server SFTP protocol v${version})`);

  const sftpFs = new SftpFS(client, 'live');
  const home = await client.realpath('.');
  console.log(`✓ realpath('.') = ${home}`);

  const remotePath = `${home}/winscp-web-xfer.bin`;
  // Clean up any stale file from a prior run.
  await sftpFs.remove(remotePath, false).catch(() => {});

  // 1. Build a ~50 KB payload of known, non-repeating bytes (a simple LCG) so a
  // byte-for-byte comparison is meaningful (not just "same length").
  const SIZE = 50 * 1024;
  const payload = new Uint8Array(SIZE);
  let seed = 0x2463a1;
  for (let i = 0; i < SIZE; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    payload[i] = seed & 0xff;
  }
  console.log(`✓ built ${SIZE} bytes of known pseudo-random content`);

  const local = new SingleFileMockFS('local-mock');
  local.seed('/local.bin', payload);

  // 2. UPLOAD: local mock -> live SFTP server, via the real transfer engine.
  let lastUploadPct = -1;
  await transferFile(local, '/local.bin', sftpFs, remotePath, payload.length, {
    chunkSize: 8192,
    onProgress: (p) => {
      const pct = p.total ? Math.floor((p.bytes / p.total) * 100) : 0;
      if (pct !== lastUploadPct && pct % 20 === 0) {
        lastUploadPct = pct;
        console.log(`  upload progress: ${pct}% (${p.bytes}/${p.total} bytes)`);
      }
    },
  });
  console.log(`✓ UPLOAD via transferFile() OK  (${payload.length} bytes, chunkSize=8192)`);

  const remoteStat = await sftpFs.stat(remotePath);
  if (remoteStat.size !== payload.length) {
    throw new Error(`Remote size mismatch after upload: expected ${payload.length}, got ${remoteStat.size}`);
  }
  console.log(`✓ remote stat confirms size=${remoteStat.size}`);

  // 3. DOWNLOAD: live SFTP server -> a second local mock, via the real transfer engine.
  const local2 = new SingleFileMockFS('local-mock-2');
  let lastDownloadPct = -1;
  await transferFile(sftpFs, remotePath, local2, '/back.bin', undefined, {
    chunkSize: 8192,
    onProgress: (p) => {
      const pct = p.total ? Math.floor((p.bytes / p.total) * 100) : 0;
      if (pct !== lastDownloadPct && pct % 20 === 0) {
        lastDownloadPct = pct;
        console.log(`  download progress: ${pct}% (${p.bytes}/${p.total ?? '?'} bytes)`);
      }
    },
  });
  console.log(`✓ DOWNLOAD via transferFile() OK`);

  // 4. Byte-compare the round trip.
  const roundTripped = local2.read('/back.bin');
  if (!bytesEqual(payload, roundTripped)) {
    throw new Error(
      `Round-trip byte mismatch: wrote ${payload.length} bytes, read back ${roundTripped.length} bytes`,
    );
  }
  console.log(`✓ byte-compare OK  (${roundTripped.length} bytes match the original exactly)`);

  // 5. Clean up the remote file.
  await sftpFs.remove(remotePath, false);
  console.log(`✓ cleaned up ${remotePath}`);

  await ssh.disconnect();
  console.log('\nTRANSFER ROUND-TRIP PASSED');
  process.exit(0);
}

main().catch((e) => {
  console.error('\n✗ VERIFICATION FAILED:', e?.stack ?? e?.message ?? e);
  process.exit(1);
});
