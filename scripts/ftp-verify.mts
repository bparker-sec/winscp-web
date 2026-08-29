// Live verification of FtpFS against a real FTP server (pyftpdlib) on the SSH
// host. Injects a Node-socket tcpConnect into the REAL connectFtp so both the
// control channel and passive data connections run over real sockets.
// Run: FTP_HOST=192.168.200.51 FTP_PORT=2121 FTP_USER=ftpuser FTP_PASS=... npx tsx scripts/ftp-verify.mts
import net from 'node:net';
import type { RawSocket } from '../src/net/ByteStream.ts';
import type { TcpConnectResult } from '../src/sdk/tcp.ts';
import { connectFtp } from '../src/ftp/FtpConnection.ts';

const HOST = process.env.FTP_HOST!;
const PORT = parseInt(process.env.FTP_PORT ?? '2121', 10);
const USER = process.env.FTP_USER!;
const PASS = process.env.FTP_PASS!;

function nodeRawSocket(host: string, port: number): Promise<RawSocket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host);
    const chunks: Buffer[] = [];
    let waiter: ((v: string | null) => void) | null = null;
    let closed = false, settled = false;
    sock.on('data', (d: Buffer) => { if (waiter) { const w = waiter; waiter = null; w(d.toString('base64')); } else chunks.push(d); });
    sock.on('close', () => { closed = true; if (waiter) { const w = waiter; waiter = null; w(null); } });
    sock.on('error', (e: Error) => { if (!settled) { settled = true; reject(e); } });
    sock.on('connect', () => {
      settled = true;
      resolve({
        async send(b64) { sock.write(Buffer.from(b64, 'base64')); return b64.length; },
        async receive() { if (chunks.length) return chunks.shift()!.toString('base64'); if (closed) return null; return new Promise<string | null>((res) => { waiter = res; }); },
        async close() { sock.destroy(); },
      });
    });
  });
}

const nodeTcpConnect = async (host: string, port: number): Promise<TcpConnectResult> => {
  try {
    return { ok: true, socket: await nodeRawSocket(host, port) };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
};

async function readAll(fs: any, path: string): Promise<Uint8Array> {
  const r = await fs.openRead(path);
  const buf = new Uint8Array(65536);
  const parts: Uint8Array[] = [];
  for (;;) { const n = await r.read(buf); if (n === 0) break; parts.push(buf.slice(0, n)); }
  await r.close();
  const total = parts.reduce((a, c) => a + c.byteLength, 0);
  const out = new Uint8Array(total); let o = 0;
  for (const c of parts) { out.set(c, o); o += c.byteLength; }
  return out;
}
async function writeFile(fs: any, path: string, data: Uint8Array) {
  const w = await fs.openWrite(path, data.byteLength);
  await w.write(data.subarray(0, Math.floor(data.length / 2)));
  await w.write(data.subarray(Math.floor(data.length / 2)));
  await w.close();
}
function bytesEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function main() {
  console.log(`Connecting to FTP ${USER}@${HOST}:${PORT} ...`);
  const { fs, home, close } = await connectFtp(
    { host: HOST, port: PORT, username: USER, password: PASS },
    'live-ftp',
    { tcpConnect: nodeTcpConnect },
  );
  console.log(`✓ connected (home=${home})`);

  const dir = `${home === '/' ? '' : home}/wsz-ftp-test`.replace(/\/+/g, '/');
  await fs.remove(dir, true).catch(() => {});

  await fs.mkdir(dir);
  console.log(`✓ MKD ${dir}`);

  // STOR + RETR byte-compare
  const SIZE = 300 * 1024 + 11;
  const payload = new Uint8Array(SIZE);
  let seed = 0xabcd;
  for (let i = 0; i < SIZE; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; payload[i] = seed & 0xff; }
  const filePath = `${dir}/upload.bin`;
  await writeFile(fs, filePath, payload);
  console.log(`✓ STOR ${SIZE} bytes (passive data conn)`);
  const readBack = await readAll(fs, filePath);
  if (!bytesEqual(payload, readBack)) throw new Error('RETR byte mismatch');
  console.log(`✓ RETR byte-exact (${readBack.length} bytes)`);

  // list (MLSD or LIST)
  const listing = await fs.list(dir);
  const entry = listing.find((e: any) => e.name === 'upload.bin');
  if (!entry) throw new Error('list missing upload.bin');
  console.log(`✓ list: ${listing.map((e: any) => `${e.name}(${e.kind},${e.size ?? '?'})`).join(', ')}`);

  // stat
  const st = await fs.stat(filePath);
  if (st.kind !== 'file') throw new Error(`stat wrong kind: ${st.kind}`);
  console.log(`✓ stat: ${st.kind} size=${st.size}`);

  // Range read via REST
  const rh = await fs.openRead(filePath, 150 * 1024);
  const tail = new Uint8Array(16);
  await rh.read(tail);
  await rh.close();
  if (!bytesEqual(tail, payload.subarray(150 * 1024, 150 * 1024 + 16))) throw new Error('REST/Range read mismatch');
  console.log('✓ REST (offset) read byte-exact');

  // rename (RNFR/RNTO)
  const renamed = `${dir}/renamed.bin`;
  await fs.rename(filePath, renamed);
  const okMoved = await fs.stat(renamed).then(() => true).catch(() => false);
  if (!okMoved) throw new Error('rename failed');
  console.log('✓ RNFR/RNTO rename OK');

  // delete file + rmdir recursive
  await fs.remove(dir, true);
  const gone = await fs.stat(dir).then(() => false).catch(() => true);
  if (!gone) throw new Error('remove dir failed');
  console.log('✓ DELE + RMD recursive OK');

  await close();
  console.log('\nFTP LIVE VERIFICATION PASSED');
  process.exit(0);
}
main().catch((e) => { console.error('\n✗ FAILED:', e?.stack ?? e); process.exit(1); });
