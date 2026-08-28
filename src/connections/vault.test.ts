import { describe, it, expect } from 'vitest';
import { Vault, type KeyValueStore } from './vault';

function memoryStore(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

describe('connections/vault', () => {
  it('fresh vault starts uninitialized; initialize -> unlocked; encrypt/decrypt round-trip', async () => {
    const store = memoryStore();
    const vault = new Vault(store);
    expect(vault.state).toBe('uninitialized');

    await vault.initialize('correct horse battery staple');
    expect(vault.state).toBe('unlocked');

    const { iv, ct } = await vault.encryptSecret('my sftp password');
    const plaintext = await vault.decryptSecret(iv, ct);
    expect(plaintext).toBe('my sftp password');
  });

  it('a new Vault over the same store is locked, and unlocks with the right passphrase', async () => {
    const store = memoryStore();
    const vault1 = new Vault(store);
    await vault1.initialize('correct horse battery staple');

    const vault2 = new Vault(store);
    expect(vault2.state).toBe('locked');

    const wrongResult = await vault2.unlock('wrong passphrase');
    expect(wrongResult).toBe(false);
    expect(vault2.state).toBe('locked');

    const rightResult = await vault2.unlock('correct horse battery staple');
    expect(rightResult).toBe(true);
    expect(vault2.state).toBe('unlocked');
  });

  it('lock() drops the key so encryptSecret throws; unlock again works', async () => {
    const store = memoryStore();
    const vault = new Vault(store);
    await vault.initialize('pw');

    vault.lock();
    expect(vault.state).toBe('locked');
    await expect(vault.encryptSecret('x')).rejects.toThrow('Vault is locked');

    const unlocked = await vault.unlock('pw');
    expect(unlocked).toBe(true);
    expect(vault.state).toBe('unlocked');
    const { iv, ct } = await vault.encryptSecret('after relock');
    expect(await vault.decryptSecret(iv, ct)).toBe('after relock');
  });

  it('initialize twice throws', async () => {
    const store = memoryStore();
    const vault = new Vault(store);
    await vault.initialize('pw');
    await expect(vault.initialize('pw2')).rejects.toThrow();
  });

  it('reset() clears storage and returns to uninitialized', async () => {
    const store = memoryStore();
    const vault = new Vault(store);
    await vault.initialize('pw');

    vault.reset();
    expect(vault.state).toBe('uninitialized');
    expect(store.getItem('winscp-vault')).toBeNull();

    // Can initialize fresh afterward.
    await vault.initialize('new-pw');
    expect(vault.state).toBe('unlocked');
  });

  it('decryptSecret throws when locked', async () => {
    const store = memoryStore();
    const vault = new Vault(store);
    await vault.initialize('pw');
    const { iv, ct } = await vault.encryptSecret('data');
    vault.lock();
    await expect(vault.decryptSecret(iv, ct)).rejects.toThrow('Vault is locked');
  });
});
