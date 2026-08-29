// bcrypt_pbkdf — the OpenSSH KDF used to derive key material from a passphrase
// for passphrase-protected openssh-key-v1 private keys.
//
// This is a faithful pure-TypeScript port of OpenSSH's bcrypt_pbkdf.c and the
// Blowfish primitives it depends on (blowfish.c). The KDF layers a fixed-cost
// bcrypt hash ("OxychromaticBlowfishSwatDynamite" encrypted 64 times) over
// SHA-512 of the password and salt, XOR-accumulating `rounds` iterations and
// spreading the result across the requested output length.
//
// Endianness note: Blowfish_stream2word reads the key/data streams big-endian,
// but bcrypt_hash writes its cdata block out little-endian. Both quirks are
// reproduced exactly below — getting either wrong yields a wrong key.
import { sha512 } from '@noble/hashes/sha512';

const BLF_N = 16;
const BCRYPT_HASHSIZE = 32; // bytes (== 8 uint32 == BCRYPT_BLOCKS words)
const BCRYPT_BLOCKS = 8; // number of uint32 words in the bcrypt hash output

// Initial P-array and S-boxes: the fractional part of pi (Blowfish standard).
// Loaded from a base64-packed table to keep this file readable; the values are
// identical to ORIG_P / ORIG_S in blowfish.c.
import { BLOWFISH_ORIG_P, BLOWFISH_ORIG_S } from './blowfish_init';

interface BlowfishCtx {
  P: Uint32Array; // 18 words
  S: Uint32Array; // 4 * 256 words, flattened
}

function initState(): BlowfishCtx {
  return { P: BLOWFISH_ORIG_P.slice(), S: BLOWFISH_ORIG_S.slice() };
}

// F function operating on the flattened S-box (S[box*256 + index]).
function F(S: Uint32Array, x: number): number {
  const a = (x >>> 24) & 0xff;
  const b = (x >>> 16) & 0xff;
  const c = (x >>> 8) & 0xff;
  const d = x & 0xff;
  // ((S0[a] + S1[b]) ^ S2[c]) + S3[d], all mod 2^32.
  let y = (S[a] + S[256 + b]) >>> 0;
  y = (y ^ S[512 + c]) >>> 0;
  y = (y + S[768 + d]) >>> 0;
  return y >>> 0;
}

// Encipher a single 64-bit block held as two uint32 halves. Returns [xl, xr].
function encipher(ctx: BlowfishCtx, xl: number, xr: number): [number, number] {
  const P = ctx.P;
  const S = ctx.S;
  let Xl = xl >>> 0;
  let Xr = xr >>> 0;
  Xl = (Xl ^ P[0]) >>> 0;
  for (let i = 1; i <= BLF_N; i += 2) {
    Xr = (Xr ^ F(S, Xl) ^ P[i]) >>> 0;
    Xl = (Xl ^ F(S, Xr) ^ P[i + 1]) >>> 0;
  }
  // Final swap folded into the output assignment (matches blowfish.c:
  // *xl = Xr ^ p[17]; *xr = Xl).
  const outL = Xr ^ P[BLF_N + 1];
  const outR = Xl;
  return [outL >>> 0, outR >>> 0];
}

// Read 4 bytes big-endian from `data`, cyclically, advancing `current`.
// Returns [word, newCurrent].
function stream2word(data: Uint8Array, current: number): [number, number] {
  let temp = 0;
  let j = current;
  for (let i = 0; i < 4; i++, j++) {
    if (j >= data.length) j = 0;
    temp = ((temp << 8) | data[j]) >>> 0;
  }
  return [temp >>> 0, j];
}

// Blowfish_expand0state: standard key expansion (no separate data stream).
function expand0state(ctx: BlowfishCtx, key: Uint8Array): void {
  const P = ctx.P;
  const S = ctx.S;
  let j = 0;
  for (let i = 0; i < BLF_N + 2; i++) {
    const [word, nj] = stream2word(key, j);
    j = nj;
    P[i] = (P[i] ^ word) >>> 0;
  }

  let datal = 0;
  let datar = 0;
  for (let i = 0; i < BLF_N + 2; i += 2) {
    [datal, datar] = encipher(ctx, datal, datar);
    P[i] = datal;
    P[i + 1] = datar;
  }

  for (let box = 0; box < 4; box++) {
    for (let k = 0; k < 256; k += 2) {
      [datal, datar] = encipher(ctx, datal, datar);
      S[box * 256 + k] = datal;
      S[box * 256 + k + 1] = datar;
    }
  }
}

// Blowfish_expandstate: EksBlowfishSetup, mixing in a separate `data` stream.
function expandstate(ctx: BlowfishCtx, data: Uint8Array, key: Uint8Array): void {
  const P = ctx.P;
  const S = ctx.S;
  let j = 0;
  for (let i = 0; i < BLF_N + 2; i++) {
    const [word, nj] = stream2word(key, j);
    j = nj;
    P[i] = (P[i] ^ word) >>> 0;
  }

  let datal = 0;
  let datar = 0;
  let dj = 0;
  for (let i = 0; i < BLF_N + 2; i += 2) {
    let w: number;
    [w, dj] = stream2word(data, dj);
    datal = (datal ^ w) >>> 0;
    [w, dj] = stream2word(data, dj);
    datar = (datar ^ w) >>> 0;
    [datal, datar] = encipher(ctx, datal, datar);
    P[i] = datal;
    P[i + 1] = datar;
  }

  for (let box = 0; box < 4; box++) {
    for (let k = 0; k < 256; k += 2) {
      let w: number;
      [w, dj] = stream2word(data, dj);
      datal = (datal ^ w) >>> 0;
      [w, dj] = stream2word(data, dj);
      datar = (datar ^ w) >>> 0;
      [datal, datar] = encipher(ctx, datal, datar);
      S[box * 256 + k] = datal;
      S[box * 256 + k + 1] = datar;
    }
  }
}

const MAGIC_WORDS = new TextEncoder().encode('OxychromaticBlowfishSwatDynamite'); // 32 bytes

// bcrypt_hash: the fixed-cost hash at the core of the KDF. Produces 32 bytes.
function bcryptHash(sha2pass: Uint8Array, sha2salt: Uint8Array): Uint8Array {
  const ctx = initState();
  expandstate(ctx, sha2salt, sha2pass);
  for (let i = 0; i < 64; i++) {
    expand0state(ctx, sha2salt);
    expand0state(ctx, sha2pass);
  }

  // cdata = the 32 magic bytes, read as 8 big-endian words (cyclically).
  const cdata = new Uint32Array(BCRYPT_BLOCKS);
  let j = 0;
  for (let i = 0; i < BCRYPT_BLOCKS; i++) {
    const [word, nj] = stream2word(MAGIC_WORDS, j);
    j = nj;
    cdata[i] = word;
  }

  // Encrypt cdata 64 times (blf_enc over 4 uint64 blocks each pass).
  for (let round = 0; round < 64; round++) {
    for (let blk = 0; blk < BCRYPT_BLOCKS; blk += 2) {
      const [l, r] = encipher(ctx, cdata[blk], cdata[blk + 1]);
      cdata[blk] = l;
      cdata[blk + 1] = r;
    }
  }

  // Store little-endian.
  const out = new Uint8Array(BCRYPT_HASHSIZE);
  for (let i = 0; i < BCRYPT_BLOCKS; i++) {
    out[4 * i + 3] = (cdata[i] >>> 24) & 0xff;
    out[4 * i + 2] = (cdata[i] >>> 16) & 0xff;
    out[4 * i + 1] = (cdata[i] >>> 8) & 0xff;
    out[4 * i + 0] = cdata[i] & 0xff;
  }
  return out;
}

/**
 * Derive `keylen` bytes of key material from a passphrase using the OpenSSH
 * bcrypt_pbkdf KDF.
 */
export function bcryptPbkdf(
  password: Uint8Array,
  salt: Uint8Array,
  rounds: number,
  keylen: number,
): Uint8Array {
  if (rounds < 1) throw new Error('bcrypt_pbkdf: rounds must be >= 1');
  if (password.length === 0) throw new Error('bcrypt_pbkdf: empty password');
  if (salt.length === 0) throw new Error('bcrypt_pbkdf: empty salt');
  if (keylen === 0 || keylen > BCRYPT_HASHSIZE * BCRYPT_HASHSIZE) {
    throw new Error('bcrypt_pbkdf: invalid keylen');
  }

  const origKeylen = keylen;
  const key = new Uint8Array(origKeylen);

  const sha2pass = sha512(password); // 64 bytes, computed once
  const out = new Uint8Array(BCRYPT_HASHSIZE);
  let tmpout: Uint8Array = new Uint8Array(BCRYPT_HASHSIZE);

  const stride = Math.floor((keylen + BCRYPT_HASHSIZE - 1) / BCRYPT_HASHSIZE);
  const amt = Math.floor((keylen + stride - 1) / stride);

  let count = 1;
  while (keylen > 0) {
    const countsalt = new Uint8Array(4);
    countsalt[0] = (count >>> 24) & 0xff;
    countsalt[1] = (count >>> 16) & 0xff;
    countsalt[2] = (count >>> 8) & 0xff;
    countsalt[3] = count & 0xff;

    // First round: salt is salt || count.
    const h = sha512.create();
    h.update(salt);
    h.update(countsalt);
    let sha2salt = h.digest();

    tmpout = bcryptHash(sha2pass, sha2salt);
    out.set(tmpout);

    for (let i = 1; i < rounds; i++) {
      // Subsequent rounds: salt is sha512(previous tmpout).
      sha2salt = sha512(tmpout);
      tmpout = bcryptHash(sha2pass, sha2salt);
      for (let k = 0; k < BCRYPT_HASHSIZE; k++) out[k] ^= tmpout[k];
    }

    const thisAmt = Math.min(amt, keylen);
    let i = 0;
    for (; i < thisAmt; i++) {
      const dest = i * stride + (count - 1);
      if (dest >= origKeylen) break;
      key[dest] = out[i];
    }
    keylen -= i;
    count++;
  }

  return key;
}
