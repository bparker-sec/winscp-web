# WinSCP Web — Plan 3a: SSH Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development with a spec reviewer + code-quality reviewer per major step. Steps use checkbox (`- [ ]`).

**Goal:** Build the pure, test-vector-verifiable foundations of the in-browser SSH client: a base64 codec, a buffered TCP byte-stream over the SDK `tcp` API, the SSH wire-format codec (incl. mpint), and the crypto primitives (X25519 key agreement, Ed25519 verify, SSH AES-GCM cipher, SSH KDF). No transport state machine yet — that is Plan 3b.

**Architecture:** Each module is small, single-purpose, and unit-tested against known vectors (RFC 7748 for X25519, RFC 8032 for Ed25519, NIST for AES-GCM, self-consistent derivations for the KDF and wire codec). The crypto is pure JS via `@noble/curves`, `@noble/ciphers`, `@noble/hashes` (already installed). Nothing here touches the network at runtime except through the injected socket, so every module is deterministically testable.

**Tech Stack:** `@noble/curves@1.9`, `@noble/ciphers@1.3`, `@noble/hashes@1.8`, TypeScript, Vitest.

**Verified import paths (do not change):**
- `import { x25519, ed25519 } from '@noble/curves/ed25519';`
- `import { gcm } from '@noble/ciphers/aes';` — `gcm(key, nonce, AAD?).encrypt(pt)` returns `ciphertext||tag` (16-byte tag appended); `.decrypt(ct||tag)` returns pt or throws on tag mismatch.
- `import { sha256 } from '@noble/hashes/sha2';`
- `import { concatBytes } from '@noble/hashes/utils';`

## File Structure
- `src/net/base64.ts` (+ test) — binary ⇄ base64
- `src/net/ByteStream.ts` (+ test) — buffered pull-stream over a `RawSocket`
- `src/sdk/tcp.ts` — crash-safe wrapper over `ai-publish-sdk` `tcp.connect`
- `src/ssh/wire.ts` (+ test) — `SshWriter`/`SshReader`, mpint normalization
- `src/ssh/crypto/x25519.ts` (+ test) — key agreement
- `src/ssh/crypto/ed25519.ts` (+ test) — signature verify
- `src/ssh/crypto/aesgcm.ts` (+ test) — SSH AES-GCM seal/open + IV increment
- `src/ssh/crypto/kdf.ts` (+ test) — RFC 4253 §7.2 key derivation

---

## Task 1: base64 codec (TDD)

**Files:** Create `src/net/base64.ts`, `src/net/base64.test.ts`

- [ ] **Step 1: Write `src/net/base64.test.ts`**
```ts
import { describe, it, expect } from 'vitest';
import { base64Encode, base64Decode } from './base64';

describe('base64', () => {
  it('encodes known vectors (RFC 4648)', () => {
    const enc = (s: string) => base64Encode(new TextEncoder().encode(s));
    expect(enc('')).toBe('');
    expect(enc('f')).toBe('Zg==');
    expect(enc('fo')).toBe('Zm8=');
    expect(enc('foo')).toBe('Zm9v');
    expect(enc('foob')).toBe('Zm9vYg==');
    expect(enc('fooba')).toBe('Zm9vYmE=');
    expect(enc('foobar')).toBe('Zm9vYmFy');
  });
  it('decodes back to the same bytes', () => {
    const dec = (s: string) => new TextDecoder().decode(base64Decode(s));
    expect(dec('Zm9vYmFy')).toBe('foobar');
    expect(dec('Zg==')).toBe('f');
    expect(dec('')).toBe('');
  });
  it('round-trips arbitrary binary', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    expect(Array.from(base64Decode(base64Encode(bytes)))).toEqual(Array.from(bytes));
  });
});
```

- [ ] **Step 2:** Run `npx vitest run src/net/base64.test.ts` — expect FAIL (module missing).

- [ ] **Step 3: Write `src/net/base64.ts`**
```ts
// Binary <-> base64 without relying on btoa/atob (jsdom-safe, no latin1 hazards).
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = /*#__PURE__*/ (() => {
  const t = new Int16Array(256).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) t[ALPHABET.charCodeAt(i)] = i;
  return t;
})();

export function base64Encode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + '==';
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + '=';
  }
  return out;
}

export function base64Decode(s: string): Uint8Array {
  // Strip padding and any whitespace/newlines the host may include.
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  const outLen = (clean.length * 3) >> 2;
  const out = new Uint8Array(outLen);
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = LOOKUP[clean.charCodeAt(i)];
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return o === outLen ? out : out.subarray(0, o);
}
```

- [ ] **Step 4:** Run `npx vitest run src/net/base64.test.ts` — expect PASS.
- [ ] **Step 5:** Commit: `git add src/net/base64.ts src/net/base64.test.ts && git commit -m "feat: binary base64 codec"`

---

## Task 2: ByteStream + TCP wrapper (TDD)

**Files:** Create `src/net/ByteStream.ts`, `src/net/ByteStream.test.ts`, `src/sdk/tcp.ts`

- [ ] **Step 1: Write `src/net/ByteStream.test.ts`** (drives a fake socket deterministically)
```ts
import { describe, it, expect } from 'vitest';
import { ByteStream, type RawSocket } from './ByteStream';
import { base64Encode } from './base64';

/** Fake socket that hands out preloaded receive() chunks and records sends. */
class FakeSocket implements RawSocket {
  sent: Uint8Array[] = [];
  closed = false;
  private queue: (string | null)[];
  constructor(chunks: Uint8Array[]) {
    this.queue = chunks.map((c) => base64Encode(c));
  }
  async send(b64: string) {
    // decode-independent: just record length via the caller's bytes is fine; store raw b64 length
    this.sent.push(Uint8Array.from(atobBytes(b64)));
    return this.sent[this.sent.length - 1].length;
  }
  async receive() {
    return this.queue.length ? this.queue.shift()! : null;
  }
  async close() {
    this.closed = true;
  }
}
function atobBytes(_b64: string): number[] {
  return []; // not needed for these assertions
}

describe('ByteStream', () => {
  it('readExactly assembles across multiple receive() chunks', async () => {
    const s = new ByteStream(new FakeSocket([Uint8Array.of(1, 2), Uint8Array.of(3), Uint8Array.of(4, 5, 6)]));
    expect(Array.from(await s.readExactly(4))).toEqual([1, 2, 3, 4]);
    expect(Array.from(await s.readExactly(2))).toEqual([5, 6]);
  });

  it('readExactly throws when the connection closes early', async () => {
    const s = new ByteStream(new FakeSocket([Uint8Array.of(1)]));
    await expect(s.readExactly(4)).rejects.toThrow();
  });

  it('readLine returns a CRLF-terminated line without the terminator', async () => {
    const line = new TextEncoder().encode('SSH-2.0-Server\r\nrest');
    const s = new ByteStream(new FakeSocket([line]));
    expect(await s.readLine()).toBe('SSH-2.0-Server');
    // the leftover "rest" stays buffered for the next read
    expect(Array.from(await s.readExactly(4))).toEqual(Array.from(new TextEncoder().encode('rest')));
  });

  it('write encodes to base64 and reports failure when the host returns null', async () => {
    const failing: RawSocket = {
      async send() {
        return null;
      },
      async receive() {
        return null;
      },
      async close() {},
    };
    const s = new ByteStream(failing);
    await expect(s.write(Uint8Array.of(1, 2, 3))).rejects.toThrow();
  });
});
```

- [ ] **Step 2:** Run the test — expect FAIL.

- [ ] **Step 3: Write `src/net/ByteStream.ts`**
```ts
import { base64Encode, base64Decode } from './base64';

/** The minimal socket surface ByteStream needs (matches the SDK tcp socket). */
export interface RawSocket {
  send(dataBase64: string): Promise<number | null>;
  receive(): Promise<string | null>;
  close(): Promise<void>;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * A buffered, binary, pull-based stream over a base64 RawSocket. All SSH framing
 * consumes bytes through readExactly()/readLine(); higher layers never see base64.
 */
export class ByteStream {
  private buf = new Uint8Array(0);

  constructor(private readonly sock: RawSocket) {}

  async write(bytes: Uint8Array): Promise<void> {
    const n = await this.sock.send(base64Encode(bytes));
    if (n === null) throw new Error('TCP send failed (host/socket unavailable).');
  }

  /** Read exactly n bytes, awaiting more from the socket as needed. */
  async readExactly(n: number): Promise<Uint8Array> {
    while (this.buf.length < n) await this.pull();
    const out = this.buf.subarray(0, n).slice();
    this.buf = this.buf.slice(n);
    return out;
  }

  /** Read a single \n-terminated line (used for the SSH identification banner). */
  async readLine(maxLen = 512): Promise<string> {
    for (;;) {
      const nl = this.buf.indexOf(0x0a);
      if (nl >= 0) {
        let end = nl;
        if (end > 0 && this.buf[end - 1] === 0x0d) end -= 1; // strip CR
        const line = new TextDecoder().decode(this.buf.subarray(0, end));
        this.buf = this.buf.slice(nl + 1);
        return line;
      }
      if (this.buf.length > maxLen) throw new Error('Line exceeded maximum length.');
      await this.pull();
    }
  }

  async close(): Promise<void> {
    await this.sock.close();
  }

  private async pull(): Promise<void> {
    const chunkB64 = await this.sock.receive();
    if (chunkB64 === null) throw new Error('TCP connection closed by peer.');
    const chunk = base64Decode(chunkB64);
    if (chunk.length > 0) this.buf = concat(this.buf, chunk);
  }
}
```

- [ ] **Step 4:** Run the test — expect PASS. (The FakeSocket's `send` return value only needs to be non-null; the test's `atobBytes` stub returns `[]`, so `sent` records zero-length entries — assertions only check throw/no-throw and receive assembly, which is fine. If you prefer, simplify FakeSocket.send to `return 1;` and drop `atobBytes`.)

- [ ] **Step 5: Write `src/sdk/tcp.ts`**
```ts
// Crash-safe wrapper over the ai-publish-sdk TCP proxy. The host relays raw TCP
// (SFTP/SSH) since a browser cannot open sockets directly. All data is base64.
import { tcp, type TcpSocket } from 'ai-publish-sdk';
import type { RawSocket } from '../net/ByteStream';

export type { TcpSocket };

export interface TcpConnectResult {
  ok: boolean;
  socket?: RawSocket;
  detail?: string;
}

/** Open a TCP connection through the host. Returns a RawSocket or a reason. */
export async function tcpConnect(host: string, port: number): Promise<TcpConnectResult> {
  try {
    const sock = await tcp.connect(host, port);
    if (!sock) return { ok: false, detail: 'TCP is unavailable in this host.' };
    return { ok: true, socket: sock };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
```

- [ ] **Step 6:** Run `npx tsc -p tsconfig.app.json --noEmit`. If `ai-publish-sdk` does not export `tcp`/`TcpSocket` under those names, read `node_modules/ai-publish-sdk/index.d.ts` and correct the import (the README documents a `tcp` namespace with `connect(host,port): Promise<TcpSocket|null>` and `TcpSocket { send(b64), receive(), close() }`). Report any change. The `RawSocket` interface is structurally compatible with `TcpSocket` — if the structural types differ, adapt `tcpConnect` to return an object literal implementing `RawSocket` that delegates to the SDK socket.

- [ ] **Step 7:** Commit: `git add src/net/ByteStream.ts src/net/ByteStream.test.ts src/sdk/tcp.ts && git commit -m "feat: buffered TCP byte-stream and SDK tcp wrapper"`

---

## Task 3: SSH wire codec (TDD)

**Files:** Create `src/ssh/wire.ts`, `src/ssh/wire.test.ts`

- [ ] **Step 1: Write `src/ssh/wire.test.ts`**
```ts
import { describe, it, expect } from 'vitest';
import { SshWriter, SshReader, normalizeMpint } from './wire';

describe('normalizeMpint', () => {
  it('strips leading zeros', () => {
    expect(Array.from(normalizeMpint(Uint8Array.of(0, 0, 1, 2)))).toEqual([1, 2]);
  });
  it('prepends 0x00 when the high bit is set (positive sign)', () => {
    expect(Array.from(normalizeMpint(Uint8Array.of(0x80, 0x01)))).toEqual([0x00, 0x80, 0x01]);
  });
  it('encodes zero as empty', () => {
    expect(Array.from(normalizeMpint(Uint8Array.of(0, 0)))).toEqual([]);
  });
});

describe('SshWriter/SshReader round-trip', () => {
  it('round-trips primitive types', () => {
    const w = new SshWriter()
      .byte(0x14)
      .bool(true)
      .uint32(0xdeadbeef)
      .string(new TextEncoder().encode('hello'))
      .nameList(['aes256-gcm@openssh.com', 'aes128-gcm@openssh.com'])
      .mpint(Uint8Array.of(0x80, 0x00));
    const r = new SshReader(w.finish());
    expect(r.byte()).toBe(0x14);
    expect(r.bool()).toBe(true);
    expect(r.uint32()).toBe(0xdeadbeef);
    expect(new TextDecoder().decode(r.string())).toBe('hello');
    expect(r.nameList()).toEqual(['aes256-gcm@openssh.com', 'aes128-gcm@openssh.com']);
    expect(Array.from(r.string())).toEqual([0x00, 0x80, 0x00]); // mpint written as a string
  });

  it('string() length-prefixes correctly', () => {
    const bytes = new TextEncoder().encode('abc');
    const buf = new SshWriter().string(bytes).finish();
    expect(Array.from(buf.subarray(0, 4))).toEqual([0, 0, 0, 3]);
  });

  it('reads an empty name-list as an empty array', () => {
    const buf = new SshWriter().nameList([]).finish();
    expect(new SshReader(buf).nameList()).toEqual([]);
  });
});
```

- [ ] **Step 2:** Run the test — expect FAIL.

- [ ] **Step 3: Write `src/ssh/wire.ts`**
```ts
// SSH binary wire types (RFC 4251 §5). All multi-byte integers are big-endian.

/** Normalize a big-endian magnitude to an SSH mpint value (two's-complement, positive). */
export function normalizeMpint(magnitude: Uint8Array): Uint8Array {
  let i = 0;
  while (i < magnitude.length && magnitude[i] === 0) i++;
  const trimmed = magnitude.subarray(i);
  if (trimmed.length === 0) return new Uint8Array(0);
  if (trimmed[0] & 0x80) {
    const out = new Uint8Array(trimmed.length + 1);
    out.set(trimmed, 1);
    return out;
  }
  return trimmed.slice();
}

export class SshWriter {
  private parts: Uint8Array[] = [];
  private len = 0;

  private push(b: Uint8Array): void {
    this.parts.push(b);
    this.len += b.length;
  }

  byte(n: number): this {
    this.push(Uint8Array.of(n & 0xff));
    return this;
  }
  bool(b: boolean): this {
    return this.byte(b ? 1 : 0);
  }
  uint32(n: number): this {
    const a = new Uint8Array(4);
    new DataView(a.buffer).setUint32(0, n >>> 0);
    this.push(a);
    return this;
  }
  uint64(n: bigint): this {
    const a = new Uint8Array(8);
    new DataView(a.buffer).setBigUint64(0, n);
    this.push(a);
    return this;
  }
  raw(b: Uint8Array): this {
    this.push(b.slice());
    return this;
  }
  string(b: Uint8Array | string): this {
    const bytes = typeof b === 'string' ? new TextEncoder().encode(b) : b;
    this.uint32(bytes.length);
    this.push(bytes.slice());
    return this;
  }
  /** Write a big-endian magnitude as an SSH mpint (normalized, length-prefixed). */
  mpint(magnitude: Uint8Array): this {
    return this.string(normalizeMpint(magnitude));
  }
  nameList(names: string[]): this {
    return this.string(names.join(','));
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.len);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

export class SshReader {
  private off = 0;
  constructor(private readonly buf: Uint8Array) {}

  private view(): DataView {
    return new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
  }

  byte(): number {
    return this.buf[this.off++];
  }
  bool(): boolean {
    return this.byte() !== 0;
  }
  uint32(): number {
    const v = this.view().getUint32(this.off);
    this.off += 4;
    return v;
  }
  uint64(): bigint {
    const v = this.view().getBigUint64(this.off);
    this.off += 8;
    return v;
  }
  bytes(n: number): Uint8Array {
    const b = this.buf.subarray(this.off, this.off + n).slice();
    this.off += n;
    return b;
  }
  string(): Uint8Array {
    return this.bytes(this.uint32());
  }
  nameList(): string[] {
    const s = new TextDecoder().decode(this.string());
    return s.length === 0 ? [] : s.split(',');
  }
  remaining(): Uint8Array {
    return this.buf.subarray(this.off).slice();
  }
  get offset(): number {
    return this.off;
  }
}
```

- [ ] **Step 4:** Run the test — expect PASS.
- [ ] **Step 5:** Commit: `git add src/ssh/wire.ts src/ssh/wire.test.ts && git commit -m "feat: SSH wire codec (writer/reader/mpint)"`

---

## Task 4: X25519 + Ed25519 primitives (TDD, RFC vectors)

**Files:** Create `src/ssh/crypto/x25519.ts`, `src/ssh/crypto/ed25519.ts`, and their tests.

- [ ] **Step 1: Write `src/ssh/crypto/x25519.test.ts`** (RFC 7748 §5.2 vector)
```ts
import { describe, it, expect } from 'vitest';
import { x25519SharedSecret, x25519KeyPair } from './x25519';

function hex(h: string): Uint8Array {
  return Uint8Array.from(h.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
}
function toHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

describe('x25519', () => {
  it('matches the RFC 7748 test vector', () => {
    const scalar = hex('a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4');
    const u = hex('e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c');
    const out = 'c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552';
    expect(toHex(x25519SharedSecret(scalar, u))).toBe(out);
  });

  it('produces a working ECDH pair (both sides agree)', () => {
    const a = x25519KeyPair();
    const b = x25519KeyPair();
    expect(toHex(x25519SharedSecret(a.secret, b.publicKey))).toBe(
      toHex(x25519SharedSecret(b.secret, a.publicKey)),
    );
  });
});
```

- [ ] **Step 2: Write `src/ssh/crypto/x25519.ts`**
```ts
import { x25519 } from '@noble/curves/ed25519';

export interface X25519KeyPair {
  secret: Uint8Array; // 32 bytes
  publicKey: Uint8Array; // 32 bytes
}

export function x25519KeyPair(): X25519KeyPair {
  const secret = x25519.utils.randomPrivateKey();
  return { secret, publicKey: x25519.getPublicKey(secret) };
}

export function x25519SharedSecret(secret: Uint8Array, peerPublic: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(secret, peerPublic);
}
```

- [ ] **Step 3:** Run `npx vitest run src/ssh/crypto/x25519.test.ts` — expect PASS. If `x25519.utils.randomPrivateKey`/`getPublicKey`/`getSharedSecret` are named differently in the installed version, inspect `node_modules/@noble/curves/ed25519.d.ts` and adjust; report changes. (The RFC-vector test is the source of truth for `x25519SharedSecret`.)

- [ ] **Step 4: Write `src/ssh/crypto/ed25519.test.ts`** (RFC 8032 §7.1 TEST 1)
```ts
import { describe, it, expect } from 'vitest';
import { ed25519Verify } from './ed25519';

function hex(h: string): Uint8Array {
  return Uint8Array.from(h.match(/.{2}/g)?.map((b) => parseInt(b, 16)) ?? []);
}

describe('ed25519 verify', () => {
  const pub = hex('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
  const msg = hex(''); // empty message (TEST 1)
  const sig = hex(
    'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
  );

  it('accepts a valid signature', () => {
    expect(ed25519Verify(sig, msg, pub)).toBe(true);
  });
  it('rejects a tampered signature', () => {
    const bad = sig.slice();
    bad[0] ^= 0xff;
    expect(ed25519Verify(bad, msg, pub)).toBe(false);
  });
  it('never throws on malformed input', () => {
    expect(ed25519Verify(new Uint8Array(3), msg, pub)).toBe(false);
  });
});
```

- [ ] **Step 5: Write `src/ssh/crypto/ed25519.ts`**
```ts
import { ed25519 } from '@noble/curves/ed25519';

/** Verify an Ed25519 signature. Never throws (malformed input → false). */
export function ed25519Verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}
```

- [ ] **Step 6:** Run `npx vitest run src/ssh/crypto/ed25519.test.ts` — expect PASS.
- [ ] **Step 7:** Commit: `git add src/ssh/crypto/x25519.ts src/ssh/crypto/x25519.test.ts src/ssh/crypto/ed25519.ts src/ssh/crypto/ed25519.test.ts && git commit -m "feat: X25519 and Ed25519 primitives"`

---

## Task 5: SSH AES-GCM cipher (TDD)

**Files:** Create `src/ssh/crypto/aesgcm.ts`, `src/ssh/crypto/aesgcm.test.ts`

SSH `aes*-gcm@openssh.com` (RFC 5647): the 4-byte packet_length is sent in clear and used as the GCM AAD; the rest (`padding_length || payload || padding`) is AES-GCM encrypted; the 16-byte tag follows. The 12-byte IV is `fixed(4) || invocation_counter(8)`; the counter is incremented (big-endian) after every packet.

- [ ] **Step 1: Write `src/ssh/crypto/aesgcm.test.ts`**
```ts
import { describe, it, expect } from 'vitest';
import { gcmSeal, gcmOpen, incrementGcmIv } from './aesgcm';

function hex(h: string): Uint8Array {
  return Uint8Array.from(h.match(/.{2}/g)?.map((b) => parseInt(b, 16)) ?? []);
}
function toHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

describe('aes-256-gcm (NIST-style known answer)', () => {
  // NIST GCM: 256-bit key, 96-bit IV, empty AAD, 16-byte plaintext.
  const key = hex('feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308');
  const iv = hex('cafebabefacedbaddecaf888');
  const pt = hex('d9313225f88406e5a55909c5aff5269a');
  const expectedCt = '522dc1f099567d07f47f37a32a84427d';
  const expectedTag = 'b1f1c3e1a3a9f7f2c9a3f4e2b6c7d8e9'; // placeholder — see note below

  it('seal produces ciphertext||tag and open recovers plaintext', () => {
    const sealed = gcmSeal(key, iv, new Uint8Array(0), pt);
    // ciphertext is the first pt.length bytes; tag is the last 16.
    expect(toHex(sealed.subarray(0, pt.length))).toBe(expectedCt);
    expect(sealed.length).toBe(pt.length + 16);
    const opened = gcmOpen(key, iv, new Uint8Array(0), sealed);
    expect(toHex(opened)).toBe(toHex(pt));
  });

  it('open throws on a tampered tag', () => {
    const sealed = gcmSeal(key, iv, new Uint8Array(0), pt);
    sealed[sealed.length - 1] ^= 0xff;
    expect(() => gcmOpen(key, iv, new Uint8Array(0), sealed)).toThrow();
  });

  it('AAD is authenticated (wrong AAD fails to open)', () => {
    const sealed = gcmSeal(key, iv, Uint8Array.of(0, 0, 0, 5), pt);
    expect(() => gcmOpen(key, iv, Uint8Array.of(0, 0, 0, 6), sealed)).toThrow();
  });

  it('incrementGcmIv bumps only the 8-byte counter, big-endian', () => {
    const iv2 = hex('00000000ffffffffffffffff');
    incrementGcmIv(iv2);
    expect(toHex(iv2)).toBe('000000000000000000000000');
    const iv3 = hex('11111111000000000000000f');
    incrementGcmIv(iv3);
    expect(toHex(iv3)).toBe('1111111100000000000000 10'.replace(' ', ''));
  });
});
```
> Note on the known-answer test: the `expectedCt` above is the standard NIST GCM AES-256 test vector ciphertext. The `expectedTag` is NOT asserted directly (its value depends on the full vector); the test instead verifies the seal/open round-trip, tag length, tamper-rejection, and AAD binding — which fully exercises `gcmSeal`/`gcmOpen`. If you want an exact tag assertion, use the full NIST vector: key `feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308`, IV `cafebabefacedbaddecaf888`, AAD empty, PT `d9313225f88406e5a55909c5aff5269a`, and assert the 16-byte tag equals `output-of-noble` (compute once and pin). Keep the round-trip + tamper + AAD tests regardless.

- [ ] **Step 2: Write `src/ssh/crypto/aesgcm.ts`**
```ts
import { gcm } from '@noble/ciphers/aes';

/** AES-GCM seal: returns ciphertext||tag (16-byte tag appended by noble). */
export function gcmSeal(key: Uint8Array, iv: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
  return gcm(key, iv, aad).encrypt(plaintext);
}

/** AES-GCM open: verifies the tag and returns plaintext, or throws on mismatch. */
export function gcmOpen(key: Uint8Array, iv: Uint8Array, aad: Uint8Array, ciphertextAndTag: Uint8Array): Uint8Array {
  return gcm(key, iv, aad).decrypt(ciphertextAndTag);
}

/**
 * Increment the SSH GCM IV in place: the IV is fixed(4) || counter(8); only the
 * trailing 8-byte counter is incremented, big-endian, per RFC 5647.
 */
export function incrementGcmIv(iv: Uint8Array): void {
  for (let i = iv.length - 1; i >= 4; i--) {
    iv[i] = (iv[i] + 1) & 0xff;
    if (iv[i] !== 0) break;
  }
}
```

- [ ] **Step 3:** Run `npx vitest run src/ssh/crypto/aesgcm.test.ts`. If the direct `expectedCt` assertion fails because noble's GCM output differs, DO NOT weaken the round-trip/tamper/AAD tests — instead compute the actual ciphertext once (log it), confirm it matches the NIST vector `522dc1f099567d07f47f37a32a84427d`; if noble matches, the test passes; if the vector line was mistyped, fix only the expected constant to the verified NIST value and report it. The round-trip, tamper, AAD, and IV-increment tests must all pass.

- [ ] **Step 4:** Commit: `git add src/ssh/crypto/aesgcm.ts src/ssh/crypto/aesgcm.test.ts && git commit -m "feat: SSH AES-GCM seal/open and IV counter"`

---

## Task 6: SSH KDF (TDD)

**Files:** Create `src/ssh/crypto/kdf.ts`, `src/ssh/crypto/kdf.test.ts`

RFC 4253 §7.2: `K1 = HASH(K || H || X || session_id)`, `K2 = HASH(K || H || K1)`, `K3 = HASH(K || H || K1 || K2)`, …, key = `K1 || K2 || …` truncated to the needed length. `X` is one of the ASCII letters A–F. `K` here is the shared secret already encoded as an SSH mpint (length-prefixed).

- [ ] **Step 1: Write `src/ssh/crypto/kdf.test.ts`** (self-consistent against sha256 directly)
```ts
import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha2';
import { concatBytes } from '@noble/hashes/utils';
import { deriveKey } from './kdf';

describe('deriveKey (RFC 4253 §7.2)', () => {
  const K = Uint8Array.of(0, 0, 0, 3, 1, 2, 3); // pretend mpint
  const H = new TextEncoder().encode('exchange-hash-32-bytes-padding!!');
  const sid = H;

  it('single block for needed <= hash size', () => {
    const expected = sha256(concatBytes(K, H, Uint8Array.of(0x41 /* 'A' */), sid));
    expect(Array.from(deriveKey(K, H, 'A', sid, 32))).toEqual(Array.from(expected));
  });

  it('extends across blocks for needed > hash size', () => {
    const k1 = sha256(concatBytes(K, H, Uint8Array.of(0x43 /* 'C' */), sid));
    const k2 = sha256(concatBytes(K, H, k1));
    const expected = concatBytes(k1, k2).subarray(0, 48);
    expect(Array.from(deriveKey(K, H, 'C', sid, 48))).toEqual(Array.from(expected));
  });

  it('truncates to exactly the requested length', () => {
    expect(deriveKey(K, H, 'A', sid, 12).length).toBe(12);
  });
});
```

- [ ] **Step 2: Write `src/ssh/crypto/kdf.ts`**
```ts
import { sha256 } from '@noble/hashes/sha2';
import { concatBytes } from '@noble/hashes/utils';

export type HashFn = (data: Uint8Array) => Uint8Array;

/**
 * RFC 4253 §7.2 key derivation. `kMpint` is the shared secret already encoded as
 * an SSH mpint (length-prefixed). `letter` is 'A'..'F'. Returns `needed` bytes.
 */
export function deriveKey(
  kMpint: Uint8Array,
  h: Uint8Array,
  letter: 'A' | 'B' | 'C' | 'D' | 'E' | 'F',
  sessionId: Uint8Array,
  needed: number,
  hash: HashFn = sha256,
): Uint8Array {
  let block = hash(concatBytes(kMpint, h, Uint8Array.of(letter.charCodeAt(0)), sessionId));
  let key = block;
  while (key.length < needed) {
    block = hash(concatBytes(kMpint, h, key));
    key = concatBytes(key, block);
  }
  return key.subarray(0, needed).slice();
}
```

- [ ] **Step 3:** Run `npx vitest run src/ssh/crypto/kdf.test.ts` — expect PASS.
- [ ] **Step 4:** Commit: `git add src/ssh/crypto/kdf.ts src/ssh/crypto/kdf.test.ts && git commit -m "feat: SSH KDF (RFC 4253 7.2)"`

---

## Task 7: Full build + suite verification

- [ ] **Step 1:** Run `npm test` — all suites green (Plan 1/2 tests + the new foundation tests).
- [ ] **Step 2:** Run `npm run build` — exit 0, static-only `dist/`. Fix any type error minimally and report. (The `@noble/*` packages are ESM and tree-shakeable; confirm they bundle without Node polyfills.)
- [ ] **Step 3:** Confirm `dist/` is static-only.
- [ ] **Step 4:** Commit any build-only fixes.

---

## Self-Review

**Spec coverage (Plan 3a slice of §3.3/§3.4):**
- `net/` buffered byte-stream over the SDK tcp — Tasks 1–2. ✓
- SSH wire codec incl. mpint (needed by kex/exchange-hash) — Task 3. ✓
- curve25519 agreement — Task 4 (x25519). ✓
- host-key / user-key signature verify (ed25519) — Task 4 (ed25519); RSA verify deferred to 3b/later. ✓ (partial by design)
- AEAD cipher (aes-gcm) — Task 5; chacha20-poly1305 deferred. ✓ (partial by design)
- KDF — Task 6. ✓
- Transport state machine, KEXINIT negotiation, exchange-hash assembly, userauth, channels — Plan 3b.

**Placeholder scan:** the aes-gcm known-answer test documents its exact-tag caveat and keeps hard round-trip/tamper/AAD assertions; no TODOs in shipped code.

**Type consistency:** `RawSocket` (ByteStream) is the socket surface `sdk/tcp.ts` returns and Plan 3b's transport consumes; `SshWriter.mpint` uses `normalizeMpint`; `deriveKey` consumes the mpint-encoded K that Plan 3b will produce via `SshWriter.mpint`.
