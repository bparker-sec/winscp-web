import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha2';
import { ed25519 } from '@noble/curves/ed25519';
import { SshWriter } from './wire';
import { deriveKey } from './crypto/kdf';
import {
  buildKexInit,
  parseKexInit,
  negotiate,
  computeExchangeHash,
  parseHostKeyEd25519,
  parseSignatureEd25519,
  verifyHostSignature,
  deriveSessionKeys,
  gcmKeyLength,
  CLIENT_KEX_ALGORITHMS,
  CLIENT_HOST_KEY_ALGORITHMS,
  CLIENT_CIPHER_ALGORITHMS,
  CLIENT_MAC_ALGORITHMS,
  CLIENT_COMPRESSION_ALGORITHMS,
} from './kex';
import { SSH_MSG_KEXINIT } from './constants';

const COOKIE = Uint8Array.from({ length: 16 }, (_, i) => i);

describe('buildKexInit / parseKexInit', () => {
  it('round-trips the client preference lists', () => {
    const payload = buildKexInit(COOKIE);
    expect(payload[0]).toBe(SSH_MSG_KEXINIT);
    expect(payload[0]).toBe(20);

    const parsed = parseKexInit(payload);
    expect(parsed.kex).toEqual(CLIENT_KEX_ALGORITHMS);
    expect(parsed.hostKey).toEqual(CLIENT_HOST_KEY_ALGORITHMS);
    expect(parsed.cipherC2S).toEqual(CLIENT_CIPHER_ALGORITHMS);
    expect(parsed.cipherS2C).toEqual(CLIENT_CIPHER_ALGORITHMS);
    expect(parsed.macC2S).toEqual(CLIENT_MAC_ALGORITHMS);
    expect(parsed.macS2C).toEqual(CLIENT_MAC_ALGORITHMS);
    expect(parsed.compressionC2S).toEqual(CLIENT_COMPRESSION_ALGORITHMS);
    expect(parsed.compressionS2C).toEqual(CLIENT_COMPRESSION_ALGORITHMS);
    expect(parsed.languagesC2S).toEqual([]);
    expect(parsed.languagesS2C).toEqual([]);
  });

  it('rejects a cookie of the wrong length', () => {
    expect(() => buildKexInit(Uint8Array.of(1, 2, 3))).toThrow();
  });

  it('rejects a payload not starting with SSH_MSG_KEXINIT', () => {
    const bad = new SshWriter().byte(99).raw(COOKIE).nameList([]).nameList([]).nameList([]).nameList([]).nameList([]).nameList([]).nameList([]).nameList([]).nameList([]).nameList([]).bool(false).uint32(0).finish();
    expect(() => parseKexInit(bad)).toThrow();
  });
});

describe('negotiate', () => {
  it('picks the first client-listed name present in the server list', () => {
    expect(negotiate(['a', 'b', 'c'], ['x', 'b', 'y'])).toBe('b');
  });

  it('throws when there is no overlap', () => {
    expect(() => negotiate(['a'], ['b'])).toThrow();
  });
});

describe('computeExchangeHash', () => {
  it('matches an independently assembled sha256 over the exact field order', () => {
    const vClient = new TextEncoder().encode('SSH-2.0-WinSCPWeb_0.1');
    const vServer = new TextEncoder().encode('SSH-2.0-OpenSSH_9.6');
    const iClient = buildKexInit(COOKIE);
    const iServer = buildKexInit(Uint8Array.from({ length: 16 }, (_, i) => 15 - i));
    const kServer = new SshWriter().string('ssh-ed25519').string(new Uint8Array(32).fill(7)).finish();
    const qClient = new Uint8Array(32).fill(1);
    const qServer = new Uint8Array(32).fill(2);
    // High bit set on the first byte to exercise mpint normalization (leading 0x00 prepended).
    const sharedSecret = new Uint8Array(32).fill(0);
    sharedSecret[0] = 0x80;
    sharedSecret[31] = 0x42;

    const h = computeExchangeHash({ vClient, vServer, iClient, iServer, kServer, qClient, qServer, sharedSecret });

    const expectedBytes = new SshWriter()
      .string(vClient)
      .string(vServer)
      .string(iClient)
      .string(iServer)
      .string(kServer)
      .string(qClient)
      .string(qServer)
      .mpint(sharedSecret)
      .finish();
    const expected = sha256(expectedBytes);

    expect(Array.from(h)).toEqual(Array.from(expected));
    expect(h.length).toBe(32);
  });
});

describe('host key parsing + signature verification', () => {
  const H = new TextEncoder().encode('exchange-hash-fixture-32-bytes!!');

  function makeHostKeyAndSig(priv: Uint8Array, message: Uint8Array) {
    const pub = ed25519.getPublicKey(priv);
    const sig = ed25519.sign(message, priv);
    const kServer = new SshWriter().string('ssh-ed25519').string(pub).finish();
    const sigBlob = new SshWriter().string('ssh-ed25519').string(sig).finish();
    return { kServer, sigBlob, pub, sig };
  }

  it('parses the host-key blob', () => {
    const priv = ed25519.utils.randomPrivateKey();
    const { kServer, pub } = makeHostKeyAndSig(priv, H);
    expect(Array.from(parseHostKeyEd25519(kServer).pub)).toEqual(Array.from(pub));
  });

  it('rejects a host-key blob with the wrong type string', () => {
    const bad = new SshWriter().string('ssh-rsa').string(new Uint8Array(32)).finish();
    expect(() => parseHostKeyEd25519(bad)).toThrow();
  });

  it('parses the signature blob', () => {
    const priv = ed25519.utils.randomPrivateKey();
    const { sigBlob, sig } = makeHostKeyAndSig(priv, H);
    expect(Array.from(parseSignatureEd25519(sigBlob))).toEqual(Array.from(sig));
  });

  it('verifies a genuine signature over H end to end', () => {
    const priv = ed25519.utils.randomPrivateKey();
    const { kServer, sigBlob } = makeHostKeyAndSig(priv, H);
    expect(verifyHostSignature(kServer, sigBlob, H)).toBe(true);
  });

  it('rejects when H is tampered with', () => {
    const priv = ed25519.utils.randomPrivateKey();
    const { kServer, sigBlob } = makeHostKeyAndSig(priv, H);
    const tamperedH = H.slice();
    tamperedH[0] ^= 0xff;
    expect(verifyHostSignature(kServer, sigBlob, tamperedH)).toBe(false);
  });

  it('rejects when the signature is tampered with', () => {
    const priv = ed25519.utils.randomPrivateKey();
    const { kServer, sigBlob } = makeHostKeyAndSig(priv, H);
    const tamperedSig = sigBlob.slice();
    tamperedSig[tamperedSig.length - 1] ^= 0xff;
    expect(verifyHostSignature(kServer, tamperedSig, H)).toBe(false);
  });

  it('rejects a signature from an unrelated key', () => {
    const priv1 = ed25519.utils.randomPrivateKey();
    const priv2 = ed25519.utils.randomPrivateKey();
    const { kServer } = makeHostKeyAndSig(priv1, H);
    const { sigBlob } = makeHostKeyAndSig(priv2, H);
    expect(verifyHostSignature(kServer, sigBlob, H)).toBe(false);
  });
});

describe('deriveSessionKeys', () => {
  const sharedSecret = new Uint8Array(32).fill(0);
  sharedSecret[0] = 0x80; // exercise mpint normalization here too
  sharedSecret[31] = 0x99;
  const H = new TextEncoder().encode('exchange-hash-fixture-32-bytes!!');
  const sessionId = H;

  it('produces IVs of 12 bytes and keys of 32 bytes', () => {
    const keys = deriveSessionKeys(sharedSecret, H, sessionId);
    expect(keys.ivC2S.length).toBe(12);
    expect(keys.ivS2C.length).toBe(12);
    expect(keys.keyC2S.length).toBe(32);
    expect(keys.keyS2C.length).toBe(32);
  });

  it('derives distinct c2s/s2c keys', () => {
    const keys = deriveSessionKeys(sharedSecret, H, sessionId);
    expect(Array.from(keys.keyC2S)).not.toEqual(Array.from(keys.keyS2C));
    expect(Array.from(keys.ivC2S)).not.toEqual(Array.from(keys.ivS2C));
  });

  it('feeds the KDF the mpint-encoded shared secret, not the raw bytes', () => {
    const kMpint = new SshWriter().mpint(sharedSecret).finish();
    // Sanity: normalization actually changed the bytes here (leading 0x00 prepended).
    expect(kMpint.length).toBe(4 + 33);

    const expectedKeyC2S = deriveKey(kMpint, H, 'C', sessionId, 32);
    const keys = deriveSessionKeys(sharedSecret, H, sessionId);
    expect(Array.from(keys.keyC2S)).toEqual(Array.from(expectedKeyC2S));
  });
});

describe('gcmKeyLength', () => {
  it('returns 16 for aes128-gcm@openssh.com', () => {
    expect(gcmKeyLength('aes128-gcm@openssh.com')).toBe(16);
  });

  it('returns 32 for aes256-gcm@openssh.com', () => {
    expect(gcmKeyLength('aes256-gcm@openssh.com')).toBe(32);
  });
});
