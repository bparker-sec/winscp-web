import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import {
  parseOpenSshPrivateKey,
  isEncryptedOpenSshKey,
  EncryptedKeyError,
} from './privatekey';

// Real fixtures generated with Git-for-Windows ssh-keygen. One ed25519 key was
// created unencrypted, then the SAME key was re-exported under three ciphers:
//   ssh-keygen -t ed25519 -N "" -f k_plain -C fixture
//   ssh-keygen -p -N "hunter2" -f k_ctr -Z aes256-ctr
//   ssh-keygen -p -N "hunter2" -f k_cbc -Z aes256-cbc
//   ssh-keygen -p -N "hunter2" -f k_gcm -Z aes256-gcm@openssh.com
// The expected seed/publicKey below were extracted from the unencrypted key, so
// each encrypted variant must decrypt to exactly the same values.
const PASSPHRASE = 'hunter2';
const EXPECTED_SEED_HEX = '87ea87986bc960918df593cd099cac727019ce1f6afcb339f9734c5703fabb3b';
const EXPECTED_PUB_HEX = '7df75576bf5f8c45d253186b4fcbfc7e632d07c6807cf361210dedb7c2c35a8a';

const PLAIN_PEM = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACB991V2v1+MRdJTGGtPy/x+Yy0HxoB882EhDe23wsNaigAAAJA8JOx3PCTs
dwAAAAtzc2gtZWQyNTUxOQAAACB991V2v1+MRdJTGGtPy/x+Yy0HxoB882EhDe23wsNaig
AAAECH6oeYa8lgkY31k80JnKxycBnOH2r8szn5c0xXA/q7O333VXa/X4xF0lMYa0/L/H5j
LQfGgHzzYSEN7bfCw1qKAAAAB2ZpeHR1cmUBAgMEBQY=
-----END OPENSSH PRIVATE KEY-----`;

const CTR_PEM = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAAABBC0FctUw
E0Y3yuucNvIhgDAAAAEAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAIH33VXa/X4xF0lMY
a0/L/H5jLQfGgHzzYSEN7bfCw1qKAAAAkJNkdyO50kjaWDRI8ramW6wTsFvYFKTb9xk3cV
2G6IOlCOCvqSxjBjFQrA2OEJR35zWZNxplTvN4YpWU7a3hVlhhLqNG5+XgDjRrWUR8eB65
gZME670/NniHD9iQcDTMfCp7YCaD6kJvNpVXr/oJnUwgN7FPanJz00gbPPsNq17why5HyA
Pycc+8OQyF89xVoA==
-----END OPENSSH PRIVATE KEY-----`;

const CBC_PEM = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jYmMAAAAGYmNyeXB0AAAAGAAAABBlH2TwnJ
PojNjZPGTz19GEAAAAEAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAIH33VXa/X4xF0lMY
a0/L/H5jLQfGgHzzYSEN7bfCw1qKAAAAkNF0F8zzmxVqnPJJ+IQDP03lwIHIr87+4ILc2u
5Qf0AHLUGcMQfqZ8+uAXlK+/W8grew9zxj3gVSP9ZFOQ04m5zkX3AGwQbbckA+t1n8vYpe
zY3nvf40hP2eaWUaaJxrAeaIipVSFqwUPGI5BFKtHvFZrBcjxBdlHmncTmmI5QcBMU1gGB
jSXCuBxrIPPzthTg==
-----END OPENSSH PRIVATE KEY-----`;

const GCM_PEM = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAAFmFlczI1Ni1nY21Ab3BlbnNzaC5jb20AAAAGYmNyeXB0AA
AAGAAAABBU0+/iYtoPoAPkT+ZDx7jpAAAAEAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAA
IH33VXa/X4xF0lMYa0/L/H5jLQfGgHzzYSEN7bfCw1qKAAAAkPxiWGfLnyw/4hgjD2UJgm
W7OdipZZ+B1Dt+2r4Om5H0zT7sw5kqVp9VX4umX2ALyiyqMPgzZt+7gIXKFFWBCBMbqKRD
hwBHFjb5Z8/P+LjTBoxIIzOsgGzWrNud4kxw2U/lhR9OS1ALRAMAoSZP0YxeUqi7h8wPk6
Y4cBqcGp5GzbSW1dOuVyMrUlnKHIg0N0cL9jSxzje/vdAxq1WZdhk=
-----END OPENSSH PRIVATE KEY-----`;

function hex(u: Uint8Array): string {
  return Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
}

describe('parseOpenSshPrivateKey — encrypted keys', () => {
  it('isEncryptedOpenSshKey distinguishes encrypted from unencrypted keys', () => {
    expect(isEncryptedOpenSshKey(PLAIN_PEM)).toBe(false);
    expect(isEncryptedOpenSshKey(CTR_PEM)).toBe(true);
    expect(isEncryptedOpenSshKey(CBC_PEM)).toBe(true);
    expect(isEncryptedOpenSshKey(GCM_PEM)).toBe(true);
    expect(isEncryptedOpenSshKey('not a key at all')).toBe(false);
  });

  it('the unencrypted fixture yields the expected seed and publicKey', () => {
    const parsed = parseOpenSshPrivateKey(PLAIN_PEM);
    expect(hex(parsed.seed)).toBe(EXPECTED_SEED_HEX);
    expect(hex(parsed.publicKey)).toBe(EXPECTED_PUB_HEX);
    // self-consistency: the public key derives from the seed.
    expect(hex(ed25519.getPublicKey(parsed.seed))).toBe(EXPECTED_PUB_HEX);
  });

  for (const [name, pem] of [
    ['aes256-ctr', CTR_PEM],
    ['aes256-cbc', CBC_PEM],
    ['aes256-gcm@openssh.com', GCM_PEM],
  ] as const) {
    it(`decrypts ${name} with the correct passphrase to the same seed`, () => {
      const parsed = parseOpenSshPrivateKey(pem, PASSPHRASE);
      expect(hex(parsed.seed)).toBe(EXPECTED_SEED_HEX);
      expect(hex(parsed.publicKey)).toBe(EXPECTED_PUB_HEX);
      // byte-equal to the unencrypted parse
      const plain = parseOpenSshPrivateKey(PLAIN_PEM);
      expect(Array.from(parsed.seed)).toEqual(Array.from(plain.seed));
      expect(Array.from(parsed.publicKey)).toEqual(Array.from(plain.publicKey));
    });

    it(`throws EncryptedKeyError for ${name} with no passphrase`, () => {
      expect(() => parseOpenSshPrivateKey(pem)).toThrow(EncryptedKeyError);
      expect(() => parseOpenSshPrivateKey(pem, '')).toThrow(EncryptedKeyError);
    });

    it(`throws a passphrase error for ${name} with the wrong passphrase`, () => {
      expect(() => parseOpenSshPrivateKey(pem, 'wrong-passphrase')).toThrow(
        /[Ii]ncorrect passphrase/,
      );
    });
  }
});
