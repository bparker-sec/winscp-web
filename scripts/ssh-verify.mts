// Live SSH transport verification harness (DEV TOOL — not part of the app bundle).
//
// Drives the REAL browser SshClient over a Node TCP socket (standing in for the
// host `tcp` proxy the browser uses) against a live SSH server, proving kex +
// host-key verify + publickey auth + the sftp subsystem all work end-to-end.
//
// Run:  npx tsx scripts/ssh-verify.mts
// Env:  SSH_HOST (required), SSH_PORT (default 22), SSH_USER (required),
//       SSH_KEY  (path to an unencrypted OpenSSH ed25519 private key; required)
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { ByteStream, type RawSocket } from '../src/net/ByteStream.ts';
import { SshClient } from '../src/ssh/SshClient.ts';
import { parseOpenSshPrivateKey } from '../src/ssh/privatekey.ts';
import { SshWriter, SshReader } from '../src/ssh/wire.ts';

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

async function main(): Promise<void> {
  console.log(`Connecting to ${USER}@${HOST}:${PORT} ...`);
  const raw = await nodeRawSocket(HOST, PORT);
  const stream = new ByteStream(raw);
  const client = new SshClient(stream, { host: HOST, port: PORT });

  const { fingerprint } = await client.connect((info) => {
    console.log(`  host key ${info.status}: ${info.fingerprint}`);
    return true; // trust-on-first-use for this verification run
  });
  console.log(`✓ kex + host-key verify OK  (${fingerprint})`);

  const key = parseOpenSshPrivateKey(readFileSync(KEYPATH, 'utf8'));
  await client.authenticate({
    username: USER,
    privateKey: { seed: key.seed, publicKey: key.publicKey },
  });
  console.log('✓ ed25519 publickey auth OK');

  const chan = await client.openSubsystem('sftp');
  console.log('✓ sftp subsystem opened');

  // SFTP smoke: SSH_FXP_INIT(v3) -> expect SSH_FXP_VERSION.
  // Packet = uint32 length || byte SSH_FXP_INIT(1) || uint32 version(3); length = 5.
  const init = new SshWriter().uint32(5).byte(1).uint32(3).finish();
  await chan.write(init);

  let buf = new Uint8Array(0);
  const pull = async () => {
    const d = await chan.read();
    if (d.length === 0) throw new Error('channel closed before SFTP VERSION arrived');
    const n = new Uint8Array(buf.length + d.length);
    n.set(buf);
    n.set(d, buf.length);
    buf = n;
  };
  while (buf.length < 4) await pull();
  const len = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0);
  while (buf.length < 4 + len) await pull();
  const r = new SshReader(buf.subarray(4, 4 + len));
  const type = r.byte();
  const version = r.uint32();
  if (type !== 2) throw new Error(`expected SSH_FXP_VERSION(2), got ${type}`);
  console.log(`✓ SFTP INIT/VERSION exchange OK  (server SFTP protocol v${version})`);

  await client.disconnect();
  console.log('\nALL CHECKS PASSED — the SSH transport works end-to-end against the live server.');
  process.exit(0);
}

main().catch((e) => {
  console.error('\n✗ VERIFICATION FAILED:', e?.stack ?? e?.message ?? e);
  process.exit(1);
});
