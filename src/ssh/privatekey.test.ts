import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { parseOpenSshPrivateKey, EncryptedKeyError } from './privatekey';

// Throwaway fixture keys generated with:
//   ssh-keygen -t ed25519 -N "" -f wsz_fixture -C fixture
//   ssh-keygen -t ed25519 -N "testpass" -f wsz_fixture_enc -C fixture-enc
// These are test-only keys with no real-world use; committing them is fine.

const UNENCRYPTED_PEM = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACAhRgIdCET+xtU5LxSosnaFq1qzseoHn+xctAqnpN5neQAAAJBjTs/jY07P
4wAAAAtzc2gtZWQyNTUxOQAAACAhRgIdCET+xtU5LxSosnaFq1qzseoHn+xctAqnpN5neQ
AAAEDbPx246d29TWwH8dv8CRIidYyh5+9q/NJtf0RFRrDkCSFGAh0IRP7G1TkvFKiydoWr
WrOx6gef7Fy0Cqek3md5AAAAB2ZpeHR1cmUBAgMEBQY=
-----END OPENSSH PRIVATE KEY-----`;

const UNENCRYPTED_PUB_LINE = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICFGAh0IRP7G1TkvFKiydoWrWrOx6gef7Fy0Cqek3md5 fixture';

const ENCRYPTED_PEM = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAAABA1Klddzo
DjqYUwVgrvWNfjAAAAEAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAIEWubUqhJOTtnzsY
4pRLnJ7GJdjnZAkn6XhB+M58RH1lAAAAkJXpqjwgNhCAr+FhLlSardi7r2b2lBlaBiC487
E/NF/fB/B3Faw9YRq4rhnAzJN+YMqV/HBfAK0qgFkWD+bNyw2rlHlTaVB1zf8FvMUZZhAu
MPjuCRWoT3c2pGFMyRd86ypTPyOHKGkjhQ6Z02aDazyqmKsBbKqWlc1KjugL7dcj4KnOIT
mrZparUTkzkISy3A==
-----END OPENSSH PRIVATE KEY-----`;

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

describe('parseOpenSshPrivateKey', () => {
  it('parses an unencrypted ed25519 key into a 32-byte publicKey and 32-byte seed', () => {
    const parsed = parseOpenSshPrivateKey(UNENCRYPTED_PEM);
    expect(parsed.type).toBe('ssh-ed25519');
    expect(parsed.publicKey).toBeInstanceOf(Uint8Array);
    expect(parsed.publicKey.length).toBe(32);
    expect(parsed.seed).toBeInstanceOf(Uint8Array);
    expect(parsed.seed.length).toBe(32);
  });

  it('the seed is self-consistent: ed25519.getPublicKey(seed) === parsed publicKey', () => {
    const parsed = parseOpenSshPrivateKey(UNENCRYPTED_PEM);
    const derivedPub = ed25519.getPublicKey(parsed.seed);
    expect(Array.from(derivedPub)).toEqual(Array.from(parsed.publicKey));
  });

  it('the parsed publicKey matches the public key encoded in the .pub file', () => {
    const parsed = parseOpenSshPrivateKey(UNENCRYPTED_PEM);
    const field = UNENCRYPTED_PUB_LINE.split(' ')[1];
    const pubBlob = base64ToBytes(field);
    // pubBlob = string "ssh-ed25519" || string pub(32)
    const view = new DataView(pubBlob.buffer, pubBlob.byteOffset, pubBlob.byteLength);
    const typeLen = view.getUint32(0);
    const pubOff = 4 + typeLen;
    const pubLen = view.getUint32(pubOff);
    const pub = pubBlob.slice(pubOff + 4, pubOff + 4 + pubLen);
    expect(Array.from(pub)).toEqual(Array.from(parsed.publicKey));
  });

  it('throws EncryptedKeyError for an encrypted private key with no passphrase', () => {
    expect(() => parseOpenSshPrivateKey(ENCRYPTED_PEM)).toThrow(EncryptedKeyError);
  });

  it('throws on malformed base64', () => {
    const bad = `-----BEGIN OPENSSH PRIVATE KEY-----
not-valid-base64!!!!
-----END OPENSSH PRIVATE KEY-----`;
    expect(() => parseOpenSshPrivateKey(bad)).toThrow();
  });

  it('throws on wrong magic header', () => {
    const wrongMagic = btoa('not-the-right-magic-header-bytes-1234567890');
    const bad = `-----BEGIN OPENSSH PRIVATE KEY-----\n${wrongMagic}\n-----END OPENSSH PRIVATE KEY-----`;
    expect(() => parseOpenSshPrivateKey(bad)).toThrow(/magic/);
  });

  it('throws when BEGIN/END markers are missing', () => {
    expect(() => parseOpenSshPrivateKey('not a pem at all')).toThrow();
  });
});
