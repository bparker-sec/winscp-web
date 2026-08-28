// Live IDLE-HOLD verification (DEV TOOL — not part of the app bundle).
//
// Reproduces the host's behavior that caused the "connection lost: timeout"
// flapping: the host receive RPC rejects with a "timeout" after a short idle
// window. This harness injects that exact behavior into a Node socket, wraps it
// with the SAME idleTolerantReceive used in production (src/net/receiveRetry),
// drives the REAL SshClient (which now keepalives every 15s), holds the
// connection IDLE far longer than several idle windows, and then runs an SFTP
// operation — proving an idle connection is no longer torn down, and that
// onClosed never fires during the idle.
//
// Run:  SSH_HOST=... SSH_USER=... SSH_KEY=... npx tsx scripts/idle-verify.mts
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { ByteStream, type RawSocket } from '../src/net/ByteStream.ts';
import { SshClient } from '../src/ssh/SshClient.ts';
import { parseOpenSshPrivateKey } from '../src/ssh/privatekey.ts';
import { SftpClient } from '../src/sftp/SftpClient.ts';
import { SftpFS } from '../src/sftp/SftpFS.ts';
import { idleTolerantReceive } from '../src/net/receiveRetry.ts';

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

// Injected idle window: how long a single receive waits for data before
// rejecting with "timeout" (mimics the host RPC). 6s < the 15s keepalive, so a
// healthy connection sees at most ~2 idle timeouts between keepalive replies —
// well under idleTolerantReceive's backstop of 4. This mirrors the production
// ratio (host window ~10-15s, keepalive 15s, backstop 4).
const INJECTED_IDLE_MS = 6_000;
const IDLE_HOLD_MS = 42_000; // ~7 idle windows and ~2-3 keepalive cycles

/** Node socket adapted to RawSocket, with an INJECTED idle-timeout on receive
 * (rejects "timeout" if no data arrives within INJECTED_IDLE_MS) that preserves
 * buffered data — exactly the shape idleTolerantReceive is built to tolerate. */
function nodeIdleTimeoutSocket(host: string, port: number): Promise<{ socket: RawSocket; rawClosed: () => boolean }> {
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
      const rawReceive = (): Promise<string | null> => {
        if (chunks.length) return Promise.resolve(chunks.shift()!.toString('base64'));
        if (closed) return Promise.resolve(null);
        return new Promise<string | null>((res, rej) => {
          const t = setTimeout(() => {
            // Idle window elapsed: drop the waiter so any later data lands in
            // `chunks` (not a dead promise), then reject like the host RPC.
            if (waiter) waiter = null;
            rej(new Error('timeout'));
          }, INJECTED_IDLE_MS);
          waiter = (v) => {
            clearTimeout(t);
            res(v);
          };
        });
      };
      resolve({
        socket: {
          async send(b64: string) {
            sock.write(Buffer.from(b64, 'base64'));
            return b64.length;
          },
          // The production wrapper, applied to the idle-timeout-injecting receive.
          receive: idleTolerantReceive(rawReceive),
          async close() {
            sock.destroy();
          },
        },
        rawClosed: () => closed,
      });
    });
  });
}

async function main(): Promise<void> {
  console.log(`Connecting to ${USER}@${HOST}:${PORT} (injected idle window ${INJECTED_IDLE_MS}ms) ...`);
  const { socket: raw } = await nodeIdleTimeoutSocket(HOST, PORT);
  const stream = new ByteStream(raw);

  let closedReason: string | null = null;
  const ssh = new SshClient(stream, {
    host: HOST,
    port: PORT,
    onClosed: (reason) => {
      closedReason = reason;
      console.error(`  ✗ onClosed fired: ${reason}`);
    },
  });

  await ssh.connect(() => true);
  const key = parseOpenSshPrivateKey(readFileSync(KEYPATH, 'utf8'));
  await ssh.authenticate({ username: USER, privateKey: { seed: key.seed, publicKey: key.publicKey } });
  const channel = await ssh.openSubsystem('sftp');
  const client = new SftpClient(channel);
  await client.init();
  const fs = new SftpFS(client, 'live');
  const home = await client.realpath('.');
  console.log(`✓ connected + sftp ready (home=${home})`);

  // Operation BEFORE idle.
  const before = await fs.list(home);
  console.log(`✓ list before idle: ${before.length} entries`);

  // HOLD IDLE — no SFTP traffic. The injected receive will time out every 6s;
  // idleTolerantReceive must retry, and the 15s keepalive must keep the counter
  // from ever reaching the dead-backstop. Without the fix this tears down within
  // one idle window (~6s) and onClosed fires.
  console.log(`… holding idle for ${IDLE_HOLD_MS / 1000}s (watch for spurious teardown) …`);
  const start = Date.now();
  while (Date.now() - start < IDLE_HOLD_MS) {
    await new Promise((r) => setTimeout(r, 3_000));
    if (closedReason) {
      throw new Error(`Connection was torn down during idle after ${((Date.now() - start) / 1000).toFixed(1)}s: ${closedReason}`);
    }
    process.stdout.write(`  · alive at ${((Date.now() - start) / 1000).toFixed(0)}s\n`);
  }
  console.log(`✓ survived ${IDLE_HOLD_MS / 1000}s idle with no teardown`);

  // Operation AFTER idle — proves the channel is still fully usable.
  const after = await fs.list(home);
  console.log(`✓ list after idle: ${after.length} entries`);
  if (after.length !== before.length) {
    console.warn(`  (note: entry count changed ${before.length}→${after.length}; fine if the dir was modified)`);
  }

  if (closedReason) throw new Error(`onClosed fired unexpectedly: ${closedReason}`);

  await ssh.disconnect();
  console.log('\nIDLE-HOLD VERIFICATION PASSED');
  process.exit(0);
}

main().catch((e) => {
  console.error('\n✗ IDLE VERIFICATION FAILED:', e?.stack ?? e?.message ?? e);
  process.exit(1);
});
