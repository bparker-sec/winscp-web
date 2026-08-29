// Live verification of WebDavFS against a real WebDAV server (wsgidav) running on
// the SSH host. Uses Node's global fetch (no CORS in Node), driving the real
// connectWebdav / WebDavFS code path.
// Run: WEBDAV_URL=http://192.168.200.51:8080/ WEBDAV_USER=dav WEBDAV_PASS=... npx tsx scripts/webdav-verify.mts
import { JSDOM } from 'jsdom';
// WebDavFS uses the browser DOMParser; provide it in Node for this harness.
(globalThis as any).DOMParser = new JSDOM().window.DOMParser;
import { connectWebdav } from '../src/webdav/WebDavConnection.ts';

const URL_ = process.env.WEBDAV_URL!;
const USER = process.env.WEBDAV_USER!;
const PASS = process.env.WEBDAV_PASS!;

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
  // Write in two chunks to exercise buffering.
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
  console.log(`Connecting to WebDAV ${URL_} as ${USER} ...`);
  const { fs, home } = await connectWebdav({ url: URL_, username: USER, password: PASS });
  console.log(`✓ connected (home=${home})`);

  const dir = `${home === '/' ? '' : home}/wsz-dav-test`.replace(/\/+/g, '/');
  await fs.remove(dir, true).catch(() => {});

  // mkdir
  await fs.mkdir(dir);
  console.log(`✓ mkdir ${dir}`);
  // mkdir again → exists
  const existsErr = await fs.mkdir(dir).then(() => null).catch((e: any) => e);
  if (!existsErr || existsErr.code !== 'exists') throw new Error(`expected exists error, got ${existsErr?.code}`);
  console.log('✓ mkdir on existing → FsError(exists)');

  // PUT + GET byte-compare (non-trivial binary content)
  const SIZE = 200 * 1024 + 7;
  const payload = new Uint8Array(SIZE);
  let seed = 0x1234;
  for (let i = 0; i < SIZE; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; payload[i] = seed & 0xff; }
  const filePath = `${dir}/data.bin`;
  await writeFile(fs, filePath, payload);
  console.log(`✓ PUT ${SIZE} bytes`);
  const readBack = await readAll(fs, filePath);
  if (!bytesEqual(payload, readBack)) throw new Error('GET byte mismatch');
  console.log(`✓ GET byte-exact (${readBack.length} bytes)`);

  // stat
  const st = await fs.stat(filePath);
  if (st.kind !== 'file' || st.size !== SIZE) throw new Error(`stat wrong: ${JSON.stringify(st)}`);
  console.log(`✓ stat: file, size=${st.size}`);

  // list
  const listing = await fs.list(dir);
  if (!listing.find((e: any) => e.name === 'data.bin')) throw new Error('list missing data.bin');
  console.log(`✓ list: ${listing.map((e: any) => e.name).join(', ')}`);

  // Range read (openRead with offset)
  const rh = await fs.openRead(filePath, 100 * 1024);
  const tail = new Uint8Array(16);
  await rh.read(tail);
  await rh.close();
  if (!bytesEqual(tail, payload.subarray(100 * 1024, 100 * 1024 + 16))) throw new Error('Range read mismatch');
  console.log('✓ Range read (offset) byte-exact');

  // MOVE / rename
  const renamed = `${dir}/renamed.bin`;
  await fs.rename(filePath, renamed);
  const movedOk = await fs.stat(renamed).then(() => true).catch(() => false);
  const goneOk = await fs.stat(filePath).then(() => false).catch(() => true);
  if (!movedOk || !goneOk) throw new Error('MOVE failed');
  console.log('✓ MOVE (rename) OK');

  // DELETE (recursive dir)
  await fs.remove(dir, true);
  const dirGone = await fs.stat(dir).then(() => false).catch(() => true);
  if (!dirGone) throw new Error('DELETE dir failed');
  console.log('✓ DELETE recursive OK');

  console.log('\nWEBDAV LIVE VERIFICATION PASSED');
  process.exit(0);
}
main().catch((e) => { console.error('\n✗ FAILED:', e?.stack ?? e); process.exit(1); });
