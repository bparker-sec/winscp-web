// Saved-connection CRUD over localStorage, with secrets encrypted via the Vault.
// Metadata (name, host, port, username, ...) is always plaintext and readable;
// a secret (password or key passphrase) is only persisted when the caller opts
// in and the connection is not "always prompt" -- and only while the vault is
// unlocked, since encryption requires the in-memory key.
import { base64Decode, base64Encode } from '../net/base64';
import type { KeyValueStore, Vault } from './vault';

export interface SavedConnection {
  id: string;
  name: string;
  protocol: 'sftp';
  host: string;
  port: number;
  username: string;
  authMethod: 'password' | 'key';
  alwaysPrompt: boolean;
}

interface StoredConnection extends SavedConnection {
  secret?: { iv: string; ct: string };
}

interface StoreFile {
  version: 1;
  connections: StoredConnection[];
}

function isStoredConnection(v: unknown): v is StoredConnection {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  if (
    typeof obj.id !== 'string' ||
    typeof obj.name !== 'string' ||
    obj.protocol !== 'sftp' ||
    typeof obj.host !== 'string' ||
    typeof obj.port !== 'number' ||
    typeof obj.username !== 'string' ||
    (obj.authMethod !== 'password' && obj.authMethod !== 'key') ||
    typeof obj.alwaysPrompt !== 'boolean'
  ) {
    return false;
  }
  if (obj.secret !== undefined) {
    const secret = obj.secret as Record<string, unknown>;
    if (!secret || typeof secret.iv !== 'string' || typeof secret.ct !== 'string') return false;
  }
  return true;
}

function isStoreFile(v: unknown): v is StoreFile {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  return obj.version === 1 && Array.isArray(obj.connections) && obj.connections.every(isStoredConnection);
}

function stripSecret(conn: StoredConnection): SavedConnection {
  const { secret: _secret, ...meta } = conn;
  return meta;
}

export class ConnectionStore {
  private readonly vault: Vault;
  private readonly store: KeyValueStore;
  private readonly storageKey: string;

  constructor(vault: Vault, store: KeyValueStore = localStorage, storageKey = 'winscp-connections') {
    this.vault = vault;
    this.store = store;
    this.storageKey = storageKey;
  }

  static newId(): string {
    return crypto.randomUUID();
  }

  newId(): string {
    return crypto.randomUUID();
  }

  private readFile(): StoreFile {
    const raw = this.store.getItem(this.storageKey);
    if (!raw) return { version: 1, connections: [] };
    try {
      const parsed: unknown = JSON.parse(raw);
      return isStoreFile(parsed) ? parsed : { version: 1, connections: [] };
    } catch {
      return { version: 1, connections: [] };
    }
  }

  private writeFile(file: StoreFile): void {
    this.store.setItem(this.storageKey, JSON.stringify(file));
  }

  list(): SavedConnection[] {
    return this.readFile().connections.map(stripSecret);
  }

  get(id: string): SavedConnection | null {
    const found = this.readFile().connections.find((c) => c.id === id);
    return found ? stripSecret(found) : null;
  }

  hasSecret(id: string): boolean {
    const found = this.readFile().connections.find((c) => c.id === id);
    return !!found?.secret;
  }

  async save(conn: SavedConnection, secret?: string): Promise<void> {
    const file = this.readFile();
    const idx = file.connections.findIndex((c) => c.id === conn.id);
    const existing = idx === -1 ? null : file.connections[idx];

    let stored: StoredConnection = { ...conn };

    if (conn.alwaysPrompt) {
      // "Always prompt" means no secret should ever be stored -- clear any
      // prior one.
      stored = { ...conn };
    } else if (secret !== undefined) {
      if (this.vault.state !== 'unlocked') {
        throw new Error('Cannot save a connection secret while the vault is locked.');
      }
      const { iv, ct } = await this.vault.encryptSecret(secret);
      stored = { ...conn, secret: { iv: base64Encode(iv), ct: base64Encode(ct) } };
    } else if (existing?.secret) {
      // No secret provided: preserve whatever was already stored (e.g. an
      // edit that only changes metadata and doesn't retype the password).
      stored = { ...conn, secret: existing.secret };
    }

    if (idx === -1) {
      file.connections.push(stored);
    } else {
      file.connections[idx] = stored;
    }
    this.writeFile(file);
  }

  remove(id: string): void {
    const file = this.readFile();
    file.connections = file.connections.filter((c) => c.id !== id);
    this.writeFile(file);
  }

  duplicate(id: string): SavedConnection {
    const file = this.readFile();
    const found = file.connections.find((c) => c.id === id);
    if (!found) {
      throw new Error(`No saved connection with id ${id}`);
    }
    const copy: StoredConnection = {
      ...stripSecret(found),
      id: crypto.randomUUID(),
      name: `${found.name} (copy)`,
    };
    file.connections.push(copy);
    this.writeFile(file);
    return stripSecret(copy);
  }

  async getSecret(id: string): Promise<string | null> {
    const found = this.readFile().connections.find((c) => c.id === id);
    if (!found?.secret) return null;
    const iv = base64Decode(found.secret.iv);
    const ct = base64Decode(found.secret.ct);
    return this.vault.decryptSecret(iv, ct);
  }
}
