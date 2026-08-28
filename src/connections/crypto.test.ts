import { describe, it, expect } from 'vitest';
import { randomSalt, deriveKey, encryptString, decryptToString, PBKDF2_ITERATIONS } from './crypto';

describe('connections/crypto', () => {
  it('derive -> encrypt -> decrypt round-trip returns the plaintext', async () => {
    const salt = randomSalt();
    expect(salt).toBeInstanceOf(Uint8Array);
    expect(salt.length).toBe(16);
    const key = await deriveKey('correct horse battery staple', salt);
    const { iv, ct } = await encryptString(key, 'hello vault');
    expect(iv.length).toBe(12);
    const plaintext = await decryptToString(key, iv, ct);
    expect(plaintext).toBe('hello vault');
  });

  it('a key derived from a DIFFERENT passphrase fails to decrypt', async () => {
    const salt = randomSalt();
    const key1 = await deriveKey('passphrase-one', salt);
    const key2 = await deriveKey('passphrase-two', salt);
    const { iv, ct } = await encryptString(key1, 'secret data');
    await expect(decryptToString(key2, iv, ct)).rejects.toThrow();
  });

  it('same passphrase+salt+iters deterministically derives a key that can decrypt', async () => {
    const salt = randomSalt();
    const keyA = await deriveKey('shared-pass', salt, PBKDF2_ITERATIONS);
    const keyB = await deriveKey('shared-pass', salt, PBKDF2_ITERATIONS);
    const { iv, ct } = await encryptString(keyA, 'independently encrypted');
    const plaintext = await decryptToString(keyB, iv, ct);
    expect(plaintext).toBe('independently encrypted');
  });
});
