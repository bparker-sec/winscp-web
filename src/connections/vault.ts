// Passphrase-protected vault: derives an AES-GCM key from a master passphrase
// via PBKDF2 and holds it only in memory. Persists KDF params + a verifier
// (never the passphrase or the derived key) so a later session can detect
// "locked" state and confirm a re-entered passphrase.
import { base64Decode, base64Encode } from '../net/base64';
import { PBKDF2_ITERATIONS, deriveKey, decryptToString, encryptString, randomSalt } from './crypto';

export interface KeyValueStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export type VaultState = 'uninitialized' | 'locked' | 'unlocked';

const VERIFIER_CONSTANT = 'winscp-web-vault-v1';

interface VaultMeta {
  kdf: { salt: string; iterations: number };
  verifier: { iv: string; ct: string };
}

function isVaultMeta(v: unknown): v is VaultMeta {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  const kdf = obj.kdf as Record<string, unknown> | undefined;
  const verifier = obj.verifier as Record<string, unknown> | undefined;
  return (
    !!kdf &&
    typeof kdf.salt === 'string' &&
    typeof kdf.iterations === 'number' &&
    !!verifier &&
    typeof verifier.iv === 'string' &&
    typeof verifier.ct === 'string'
  );
}

export class Vault {
  private readonly store: KeyValueStore;
  private readonly storageKey: string;
  private meta: VaultMeta | null = null;
  private key: CryptoKey | null = null;
  private _state: VaultState;

  constructor(store: KeyValueStore = localStorage, storageKey = 'winscp-vault') {
    this.store = store;
    this.storageKey = storageKey;
    this.meta = this.readMeta();
    this._state = this.meta ? 'locked' : 'uninitialized';
  }

  get state(): VaultState {
    return this._state;
  }

  private readMeta(): VaultMeta | null {
    const raw = this.store.getItem(this.storageKey);
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isVaultMeta(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async initialize(passphrase: string): Promise<void> {
    if (this._state !== 'uninitialized') {
      throw new Error('Vault is already initialized');
    }
    const salt = randomSalt();
    const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
    const { iv, ct } = await encryptString(key, VERIFIER_CONSTANT);
    const meta: VaultMeta = {
      kdf: { salt: base64Encode(salt), iterations: PBKDF2_ITERATIONS },
      verifier: { iv: base64Encode(iv), ct: base64Encode(ct) },
    };
    this.store.setItem(this.storageKey, JSON.stringify(meta));
    this.meta = meta;
    this.key = key;
    this._state = 'unlocked';
  }

  async unlock(passphrase: string): Promise<boolean> {
    if (this._state === 'uninitialized' || !this.meta) {
      throw new Error('Vault is not initialized');
    }
    const salt = base64Decode(this.meta.kdf.salt);
    const key = await deriveKey(passphrase, salt, this.meta.kdf.iterations);
    const iv = base64Decode(this.meta.verifier.iv);
    const ct = base64Decode(this.meta.verifier.ct);
    let verified: string;
    try {
      verified = await decryptToString(key, iv, ct);
    } catch {
      return false;
    }
    if (verified !== VERIFIER_CONSTANT) {
      return false;
    }
    this.key = key;
    this._state = 'unlocked';
    return true;
  }

  lock(): void {
    if (this._state === 'unlocked') {
      this.key = null;
      this._state = 'locked';
    }
  }

  reset(): void {
    this.store.removeItem(this.storageKey);
    this.meta = null;
    this.key = null;
    this._state = 'uninitialized';
  }

  async encryptSecret(plaintext: string): Promise<{ iv: Uint8Array; ct: Uint8Array }> {
    if (this._state !== 'unlocked' || !this.key) {
      throw new Error('Vault is locked');
    }
    return encryptString(this.key, plaintext);
  }

  async decryptSecret(iv: Uint8Array, ct: Uint8Array): Promise<string> {
    if (this._state !== 'unlocked' || !this.key) {
      throw new Error('Vault is locked');
    }
    return decryptToString(this.key, iv, ct);
  }
}
