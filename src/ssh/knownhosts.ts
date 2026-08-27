// TOFU (trust-on-first-use) known-hosts store + SHA256 host-key fingerprints.
import { sha256 } from '@noble/hashes/sha2';
import { base64Encode } from '../net/base64';

const STORAGE_KEY = 'winscp-knownhosts';

/** OpenSSH-style fingerprint: "SHA256:" + base64(sha256(blob)) with padding stripped. */
export function fingerprintSha256(hostKeyBlob: Uint8Array): string {
  const digest = sha256(hostKeyBlob);
  const b64 = base64Encode(digest).replace(/=+$/, '');
  return `SHA256:${b64}`;
}

function keyFor(host: string, port: number): string {
  return `${host}:${port}`;
}

function loadStore(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, string>;
    return {};
  } catch {
    return {};
  }
}

function saveStore(store: Record<string, string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // localStorage unavailable (private mode, quota, etc.) — silently ignore.
  }
}

export function getKnownFingerprint(host: string, port: number): string | null {
  const store = loadStore();
  const v = store[keyFor(host, port)];
  return typeof v === 'string' ? v : null;
}

export function rememberHost(host: string, port: number, fingerprint: string): void {
  const store = loadStore();
  store[keyFor(host, port)] = fingerprint;
  saveStore(store);
}

export type HostKeyCheck =
  | { status: 'new'; fingerprint: string }
  | { status: 'match'; fingerprint: string }
  | { status: 'mismatch'; fingerprint: string; known: string };

/** Pure classification: does NOT auto-remember. Caller decides whether to trust. */
export function checkHostKey(host: string, port: number, hostKeyBlob: Uint8Array): HostKeyCheck {
  const fingerprint = fingerprintSha256(hostKeyBlob);
  const known = getKnownFingerprint(host, port);
  if (known === null) return { status: 'new', fingerprint };
  if (known === fingerprint) return { status: 'match', fingerprint };
  return { status: 'mismatch', fingerprint, known };
}
