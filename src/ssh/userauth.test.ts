import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { SshWriter, SshReader } from './wire';
import {
  buildServiceRequest,
  buildPasswordAuth,
  buildPublicKeyBlob,
  signPublicKeyAuth,
  parseUserAuthResult,
} from './userauth';
import {
  SSH_MSG_SERVICE_REQUEST,
  SSH_MSG_USERAUTH_REQUEST,
  SSH_MSG_USERAUTH_SUCCESS,
  SSH_MSG_USERAUTH_FAILURE,
  SSH_MSG_USERAUTH_BANNER,
} from './constants';

describe('buildServiceRequest', () => {
  it('produces exact bytes', () => {
    const payload = buildServiceRequest('ssh-userauth');
    const expected = new SshWriter().byte(SSH_MSG_SERVICE_REQUEST).string('ssh-userauth').finish();
    expect(payload).toEqual(expected);
  });
});

describe('buildPasswordAuth', () => {
  it('produces exact bytes', () => {
    const payload = buildPasswordAuth('alice', 'hunter2');
    const r = new SshReader(payload);
    expect(r.byte()).toBe(SSH_MSG_USERAUTH_REQUEST);
    expect(new TextDecoder().decode(r.string())).toBe('alice');
    expect(new TextDecoder().decode(r.string())).toBe('ssh-connection');
    expect(new TextDecoder().decode(r.string())).toBe('password');
    expect(r.bool()).toBe(false);
    expect(new TextDecoder().decode(r.string())).toBe('hunter2');
  });
});

describe('buildPublicKeyBlob', () => {
  it('wraps the raw public key with the ssh-ed25519 name', () => {
    const pub = Uint8Array.from({ length: 32 }, (_, i) => i);
    const blob = buildPublicKeyBlob(pub);
    const r = new SshReader(blob);
    expect(new TextDecoder().decode(r.string())).toBe('ssh-ed25519');
    expect(r.string()).toEqual(pub);
  });
});

describe('signPublicKeyAuth', () => {
  it('produces the exact USERAUTH_REQUEST byte layout', () => {
    const seed = ed25519.utils.randomPrivateKey();
    const publicKey = ed25519.getPublicKey(seed);
    const sessionId = Uint8Array.from({ length: 32 }, (_, i) => i * 3);

    const payload = signPublicKeyAuth({ sessionId, user: 'bob', seed, publicKey });
    const r = new SshReader(payload);

    expect(r.byte()).toBe(50);
    expect(new TextDecoder().decode(r.string())).toBe('bob');
    expect(new TextDecoder().decode(r.string())).toBe('ssh-connection');
    expect(new TextDecoder().decode(r.string())).toBe('publickey');
    expect(r.bool()).toBe(true);
    expect(new TextDecoder().decode(r.string())).toBe('ssh-ed25519');
    const pk = r.string();
    const pkReader = new SshReader(pk);
    expect(new TextDecoder().decode(pkReader.string())).toBe('ssh-ed25519');
    expect(pkReader.string()).toEqual(publicKey);
    const sigBlob = r.string();

    const sr = new SshReader(sigBlob);
    expect(new TextDecoder().decode(sr.string())).toBe('ssh-ed25519');
    const rawSig = sr.string();
    expect(rawSig.length).toBe(64);

    // CRITICAL: independently reconstruct the signed-data blob and verify with
    // a real ed25519 signature check, proving we sign exactly the right bytes.
    const pkBlob = new SshWriter().string('ssh-ed25519').string(publicKey).finish();
    const signedData = new SshWriter()
      .string(sessionId)
      .byte(SSH_MSG_USERAUTH_REQUEST)
      .string('bob')
      .string('ssh-connection')
      .string('publickey')
      .bool(true)
      .string('ssh-ed25519')
      .string(pkBlob)
      .finish();

    expect(ed25519.verify(rawSig, signedData, publicKey)).toBe(true);
  });

  it('fails verification against tampered signed data (sanity check)', () => {
    const seed = ed25519.utils.randomPrivateKey();
    const publicKey = ed25519.getPublicKey(seed);
    const sessionId = Uint8Array.from({ length: 32 }, (_, i) => i);

    const payload = signPublicKeyAuth({ sessionId, user: 'bob', seed, publicKey });
    const r = new SshReader(payload);
    r.byte();
    r.string();
    r.string();
    r.string();
    r.bool();
    r.string();
    r.string();
    const sigBlob = r.string();
    const sr = new SshReader(sigBlob);
    sr.string();
    const rawSig = sr.string();

    const wrongData = new SshWriter().string('not the real signed data').finish();
    expect(ed25519.verify(rawSig, wrongData, publicKey)).toBe(false);
  });
});

describe('parseUserAuthResult', () => {
  it('parses SUCCESS', () => {
    const payload = Uint8Array.of(SSH_MSG_USERAUTH_SUCCESS);
    expect(parseUserAuthResult(payload)).toEqual({ type: 'success' });
  });

  it('parses FAILURE with methods and partial success', () => {
    const payload = new SshWriter()
      .byte(SSH_MSG_USERAUTH_FAILURE)
      .nameList(['publickey', 'password'])
      .bool(true)
      .finish();
    expect(parseUserAuthResult(payload)).toEqual({
      type: 'failure',
      methods: ['publickey', 'password'],
      partial: true,
    });
  });

  it('parses BANNER', () => {
    const payload = new SshWriter()
      .byte(SSH_MSG_USERAUTH_BANNER)
      .string('welcome')
      .string('en')
      .finish();
    expect(parseUserAuthResult(payload)).toEqual({ type: 'banner', message: 'welcome' });
  });

  it('parses other message types', () => {
    const payload = Uint8Array.of(7);
    expect(parseUserAuthResult(payload)).toEqual({ type: 'other', msg: 7 });
  });
});
