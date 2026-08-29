// WebCrypto helpers for the encrypted connection vault (PBKDF2 -> AES-GCM).
// 600k SHA-256 iterations tracks current OWASP guidance. The count is stored
// per-vault (see Vault meta), so raising it only affects newly created vaults;
// existing vaults keep unlocking with their own stored iteration count.
export const PBKDF2_ITERATIONS = 600_000;

export function randomSalt(): Uint8Array {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return salt;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number = PBKDF2_ITERATIONS
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    utf8(passphrase) as BufferSource,
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptString(
  key: CryptoKey,
  plaintext: string
): Promise<{ iv: Uint8Array; ct: Uint8Array }> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, utf8(plaintext) as BufferSource)
  );
  return { iv, ct };
}

export async function decryptToString(key: CryptoKey, iv: Uint8Array, ct: Uint8Array): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    ct as BufferSource
  );
  return new TextDecoder().decode(plaintext);
}
