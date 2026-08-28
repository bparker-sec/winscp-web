// Live SFTP round-trip verification harness (DEV TOOL — not part of the app bundle).
//
// Drives the REAL browser SFTP stack (SshClient -> SftpClient -> SftpFS) over a
// Node TCP socket (standing in for the host `tcp` proxy the browser uses)
// against a live SSH/SFTP server, exercising real file operations end-to-end.
//
// `connectSftp` itself calls the browser SDK's `tcpConnect`, which is not
// available under Node — so this harness wires the same pieces together
// manually (mirroring scripts/ssh-verify.mts) instead of calling connectSftp.
//
// Run:  npx tsx scripts/sftp-verify.mts
// Env:  SSH_HOST (required), SSH_PORT (default 22), SSH_USER (required),
//       SSH_KEY  (path to an unencrypted OpenSSH ed25519 private key; required)
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { ByteStream, type RawSocket } from '../src/net/ByteStream.ts';
import { SshClient } from '../src/ssh/SshClient.ts';
import { parseOpenSshPrivateKey } from '../src/ssh/privatekey.ts';
import { SftpClient } from '../src/sftp/SftpClient.ts';
import { SftpFS } from '../src/sftp/SftpFS.ts';

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

const TEST_DIR_SUFFIX = 'wsz-verify-fixed-20260827';

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

async function readAll(fs: SftpFS, path: string): Promise<Uint8Array> {
  const handle = await fs.openRead(path);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const buf = new Uint8Array(256);
      const n = await handle.read(buf);
      if (n === 0) break;
      chunks.push(buf.subarray(0, n));
      total += n;
    }
  } finally {
    await handle.close();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
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
  console.log('✓ sftp subsystem opened');

  const client = new SftpClient(channel);
  const version = await client.init();
  console.log(`✓ SFTP init OK  (server SFTP protocol v${version})`);

  const fs = new SftpFS(client, 'live');

  // 1. realpath
  const home = await client.realpath('.');
  console.log(`✓ realpath('.') = ${home}`);

  // 2. list
  const list = await fs.list(home);
  console.log(`✓ list(home) OK  (${list.length} entries; first few: ${list.slice(0, 5).map((e) => e.name).join(', ')})`);

  // 3-4. mkdir (clean up any stale dir from a prior run first)
  const dir = `${home}/winscp-web-test-${TEST_DIR_SUFFIX}`;
  await fs.remove(dir, true).catch(() => {});
  await fs.mkdir(dir);
  console.log(`✓ mkdir(${dir}) OK`);

  // 5. write
  const payload = new TextEncoder().encode('hello winscp-web ' + 'x'.repeat(1000));
  const filePath = `${dir}/a.txt`;
  const w = await fs.openWrite(filePath, payload.length);
  const mid = Math.floor(payload.length / 2);
  await w.write(payload.subarray(0, mid));
  await w.write(payload.subarray(mid));
  await w.close();
  console.log(`✓ openWrite/write/close OK  (${payload.length} bytes, 2 chunks)`);

  // 6. read back + compare
  const readBack = await readAll(fs, filePath);
  if (!bytesEqual(readBack, payload)) {
    throw new Error(`Read-back mismatch: wrote ${payload.length} bytes, read ${readBack.length} bytes`);
  }
  console.log(`✓ openRead/read/close OK  (read back ${readBack.length} bytes, matches written payload)`);

  // 7. stat
  const st = await fs.stat(filePath);
  if (st.size !== payload.length) {
    throw new Error(`stat size mismatch: expected ${payload.length}, got ${st.size}`);
  }
  if (st.kind !== 'file') {
    throw new Error(`stat kind mismatch: expected 'file', got '${st.kind}'`);
  }
  console.log(`✓ stat OK  (size=${st.size}, kind=${st.kind}, mode=${st.mode?.toString(8)})`);

  // 8. rename
  const renamedPath = `${dir}/b.txt`;
  await fs.rename(filePath, renamedPath);
  const afterRename = await fs.list(dir);
  const names = afterRename.map((e) => e.name);
  if (!names.includes('b.txt') || names.includes('a.txt')) {
    throw new Error(`rename verification failed: dir contains [${names.join(', ')}]`);
  }
  console.log(`✓ rename OK  (dir now contains: ${names.join(', ')})`);

  // 9. remove
  await fs.remove(renamedPath, false);
  await fs.remove(dir, false);
  console.log('✓ remove(file) + remove(empty dir) OK');

  await ssh.disconnect();
  console.log('\nALL SFTP CHECKS PASSED');
  process.exit(0);
}

main().catch((e) => {
  console.error('\n✗ VERIFICATION FAILED:', e?.stack ?? e?.message ?? e);
  process.exit(1);
});
