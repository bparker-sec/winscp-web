import { describe, it, expect, beforeEach } from 'vitest';
import { ConnectionStore, type SavedConnection } from './store';
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

function makeConn(overrides: Partial<SavedConnection> = {}): SavedConnection {
  return {
    id: crypto.randomUUID(),
    name: 'My server',
    protocol: 'sftp',
    host: 'example.com',
    port: 22,
    username: 'alice',
    authMethod: 'password',
    alwaysPrompt: false,
    ...overrides,
  };
}

describe('connections/store', () => {
  let vaultBackingStore: KeyValueStore;
  let vault: Vault;
  let connStore: KeyValueStore;
  let store: ConnectionStore;

  beforeEach(async () => {
    vaultBackingStore = memoryStore();
    vault = new Vault(vaultBackingStore);
    await vault.initialize('correct horse battery staple');
    connStore = memoryStore();
    store = new ConnectionStore(vault, connStore);
  });

  it('save metadata-only (alwaysPrompt, no secret) -> list has it, no secret, getSecret null', async () => {
    const conn = makeConn({ alwaysPrompt: true });
    await store.save(conn);

    const listed = store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(conn);
    expect(store.hasSecret(conn.id)).toBe(false);
    expect(await store.getSecret(conn.id)).toBeNull();
  });

  it('save with a secret (alwaysPrompt false) encrypts at rest and decrypts after unlock', async () => {
    const conn = makeConn({ alwaysPrompt: false });
    const plaintext = 'super-secret-password';
    await store.save(conn, plaintext);

    expect(store.hasSecret(conn.id)).toBe(true);

    const raw = connStore.getItem('winscp-connections')!;
    expect(raw).toBeTruthy();
    expect(raw.includes(plaintext)).toBe(false);
    const parsed = JSON.parse(raw);
    const storedConn = parsed.connections[0];
    expect(typeof storedConn.secret.iv).toBe('string');
    expect(typeof storedConn.secret.ct).toBe('string');

    const decrypted = await store.getSecret(conn.id);
    expect(decrypted).toBe(plaintext);
  });

  it('saving a secret while the vault is locked throws', async () => {
    vault.lock();
    const conn = makeConn();
    await expect(store.save(conn, 'password')).rejects.toThrow();
  });

  it('re-saving an existing connection without a secret clears the prior secret', async () => {
    const conn = makeConn();
    await store.save(conn, 'password');
    expect(store.hasSecret(conn.id)).toBe(true);

    await store.save(conn);
    expect(store.hasSecret(conn.id)).toBe(false);
    expect(await store.getSecret(conn.id)).toBeNull();
  });

  it('list/remove/duplicate work as expected', async () => {
    const conn = makeConn({ name: 'Prod box' });
    await store.save(conn, 'password');

    expect(store.list()).toHaveLength(1);

    const dup = store.duplicate(conn.id);
    expect(dup.id).not.toBe(conn.id);
    expect(dup.name).toBe('Prod box (copy)');
    expect(store.hasSecret(dup.id)).toBe(false);
    expect(store.list()).toHaveLength(2);

    store.remove(conn.id);
    const remaining = store.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(dup.id);
  });

  it('corrupt storage degrades to an empty list, never throws', () => {
    connStore.setItem('winscp-connections', '{bad json');
    expect(store.list()).toEqual([]);
    expect(store.get('anything')).toBeNull();
    expect(store.hasSecret('anything')).toBe(false);
  });

  it('list() never includes the secret field', async () => {
    const conn = makeConn();
    await store.save(conn, 'password');
    for (const meta of store.list()) {
      expect('secret' in meta).toBe(false);
    }
    const single = store.get(conn.id)!;
    expect('secret' in single).toBe(false);
  });
});
