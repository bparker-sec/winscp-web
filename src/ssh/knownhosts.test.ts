import { describe, it, expect, beforeEach } from 'vitest';
import { fingerprintSha256, getKnownFingerprint, rememberHost, checkHostKey } from './knownhosts';

function blob(seed: number, len = 40): Uint8Array {
  const b = new Uint8Array(len);
  for (let i = 0; i < len; i++) b[i] = (seed + i) & 0xff;
  return b;
}

describe('knownhosts', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('fingerprint format is SHA256: + base64 with no padding', () => {
    const fp = fingerprintSha256(blob(1));
    expect(fp.startsWith('SHA256:')).toBe(true);
    expect(fp).not.toContain('=');
    expect(fp).not.toContain('\n');
  });

  it('is deterministic for the same blob', () => {
    expect(fingerprintSha256(blob(5))).toBe(fingerprintSha256(blob(5)));
  });

  it('first check on an unknown host returns new', () => {
    const result = checkHostKey('example.com', 22, blob(1));
    expect(result.status).toBe('new');
    expect(result.fingerprint).toBe(fingerprintSha256(blob(1)));
    expect(getKnownFingerprint('example.com', 22)).toBeNull();
  });

  it('after rememberHost, same blob checks as match', () => {
    const fp = fingerprintSha256(blob(1));
    rememberHost('example.com', 22, fp);
    expect(getKnownFingerprint('example.com', 22)).toBe(fp);

    const result = checkHostKey('example.com', 22, blob(1));
    expect(result).toEqual({ status: 'match', fingerprint: fp });
  });

  it('a different blob for the same host checks as mismatch with both fingerprints', () => {
    const fpOld = fingerprintSha256(blob(1));
    rememberHost('example.com', 22, fpOld);

    const fpNew = fingerprintSha256(blob(99));
    const result = checkHostKey('example.com', 22, blob(99));
    expect(result).toEqual({ status: 'mismatch', fingerprint: fpNew, known: fpOld });
  });

  it('does not auto-remember on new or mismatch', () => {
    checkHostKey('newhost.com', 22, blob(1));
    expect(getKnownFingerprint('newhost.com', 22)).toBeNull();
  });

  it('different host:port keys are independent', () => {
    const fp1 = fingerprintSha256(blob(1));
    rememberHost('host-a.com', 22, fp1);
    expect(getKnownFingerprint('host-a.com', 2222)).toBeNull();
    expect(getKnownFingerprint('host-b.com', 22)).toBeNull();
  });

  it('rememberHost swallows a localStorage failure (private-mode safe)', () => {
    const orig = localStorage.setItem;
    localStorage.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    try {
      expect(() => rememberHost('example.com', 22, 'SHA256:xxx')).not.toThrow();
    } finally {
      localStorage.setItem = orig;
    }
  });

  it('getKnownFingerprint swallows a localStorage failure', () => {
    const orig = localStorage.getItem;
    localStorage.getItem = () => {
      throw new Error('SecurityError');
    };
    try {
      expect(() => getKnownFingerprint('example.com', 22)).not.toThrow();
      expect(getKnownFingerprint('example.com', 22)).toBeNull();
    } finally {
      localStorage.getItem = orig;
    }
  });
});
