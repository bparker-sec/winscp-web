import { describe, it, expect } from 'vitest';
import { matchesHostname, certMatchesHost } from './tls';

describe('FTPS hostname verification', () => {
  it('matchesHostname: exact, case-insensitive, one-label wildcard, and rejects mismatches', () => {
    expect(matchesHostname('example.com', 'example.com')).toBe(true);
    expect(matchesHostname('EXAMPLE.com', 'example.com')).toBe(true);
    expect(matchesHostname('*.example.com', 'ftp.example.com')).toBe(true);
    expect(matchesHostname('*.example.com', 'a.b.example.com')).toBe(false); // wildcard = one label
    expect(matchesHostname('example.com', 'evil.com')).toBe(false);
    expect(matchesHostname('192.168.200.51', '192.168.200.51')).toBe(true);
    expect(matchesHostname('', 'example.com')).toBe(false);
  });

  it('certMatchesHost: checks SAN then CN, rejects a cert for another host', () => {
    const cert = {
      subject: { getField: (n: string) => (n === 'CN' ? { value: 'ftp.example.com' } : null) },
      getExtension: (n: string) =>
        n === 'subjectAltName'
          ? { altNames: [{ value: 'ftp.example.com' }, { value: 'alt.example.com' }] }
          : undefined,
    };
    expect(certMatchesHost(cert, 'ftp.example.com')).toBe(true);
    expect(certMatchesHost(cert, 'alt.example.com')).toBe(true);
    expect(certMatchesHost(cert, 'evil.example.com')).toBe(false);
    expect(certMatchesHost(null, 'ftp.example.com')).toBe(false);
  });
});
