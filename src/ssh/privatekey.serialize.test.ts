import { describe, it, expect } from 'vitest';
import { encodeUnencryptedOpenSshKey, parseOpenSshPrivateKey, isEncryptedOpenSshKey } from './privatekey';

describe('encodeUnencryptedOpenSshKey', () => {
  it('round-trips seed + publicKey through an unencrypted OpenSSH PEM', () => {
    const seed = new Uint8Array(32);
    const publicKey = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      seed[i] = i;
      publicKey[i] = 255 - i;
    }
    const pem = encodeUnencryptedOpenSshKey(seed, publicKey);

    expect(pem).toContain('-----BEGIN OPENSSH PRIVATE KEY-----');
    expect(pem).toContain('-----END OPENSSH PRIVATE KEY-----');
    // The produced key is NOT passphrase-encrypted.
    expect(isEncryptedOpenSshKey(pem)).toBe(false);
    // And parses back to the exact same seed/publicKey with no passphrase.
    const parsed = parseOpenSshPrivateKey(pem);
    expect(parsed.type).toBe('ssh-ed25519');
    expect(Array.from(parsed.seed)).toEqual(Array.from(seed));
    expect(Array.from(parsed.publicKey)).toEqual(Array.from(publicKey));
  });

  it('rejects wrong-sized inputs', () => {
    expect(() => encodeUnencryptedOpenSshKey(new Uint8Array(16), new Uint8Array(32))).toThrow();
    expect(() => encodeUnencryptedOpenSshKey(new Uint8Array(32), new Uint8Array(31))).toThrow();
  });
});
