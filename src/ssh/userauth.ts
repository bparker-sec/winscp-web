// SSH userauth (RFC 4252): service request, password auth, ed25519 publickey auth.
import { ed25519 } from '@noble/curves/ed25519';
import { SshWriter, SshReader } from './wire';
import {
  SSH_MSG_SERVICE_REQUEST,
  SSH_MSG_USERAUTH_REQUEST,
  SSH_MSG_USERAUTH_FAILURE,
  SSH_MSG_USERAUTH_SUCCESS,
  SSH_MSG_USERAUTH_BANNER,
} from './constants';

const ED25519_KEY_TYPE = 'ssh-ed25519';

/** byte SERVICE_REQUEST || string service */
export function buildServiceRequest(service: string): Uint8Array {
  return new SshWriter().byte(SSH_MSG_SERVICE_REQUEST).string(service).finish();
}

/** byte USERAUTH_REQUEST || string user || string "ssh-connection" || string "password" || boolean FALSE || string password */
export function buildPasswordAuth(user: string, password: string): Uint8Array {
  return new SshWriter()
    .byte(SSH_MSG_USERAUTH_REQUEST)
    .string(user)
    .string('ssh-connection')
    .string('password')
    .bool(false)
    .string(password)
    .finish();
}

/** string "ssh-ed25519" || string publicKey */
export function buildPublicKeyBlob(publicKey: Uint8Array): Uint8Array {
  return new SshWriter().string(ED25519_KEY_TYPE).string(publicKey).finish();
}

export interface PublicKeyAuthParams {
  sessionId: Uint8Array;
  user: string;
  seed: Uint8Array;
  publicKey: Uint8Array;
}

/**
 * Build the full USERAUTH_REQUEST message for ed25519 publickey auth, including
 * the signature over the RFC 4252 §7 signed-data blob:
 *   string(sessionId) || byte(USERAUTH_REQUEST) || string(user) || string("ssh-connection")
 *     || string("publickey") || boolean(TRUE) || string("ssh-ed25519") || string(pk)
 */
export function signPublicKeyAuth({ sessionId, user, seed, publicKey }: PublicKeyAuthParams): Uint8Array {
  const pk = buildPublicKeyBlob(publicKey);

  const signedData = new SshWriter()
    .string(sessionId)
    .byte(SSH_MSG_USERAUTH_REQUEST)
    .string(user)
    .string('ssh-connection')
    .string('publickey')
    .bool(true)
    .string(ED25519_KEY_TYPE)
    .string(pk)
    .finish();

  const rawSig = ed25519.sign(signedData, seed);
  const sigBlob = new SshWriter().string(ED25519_KEY_TYPE).string(rawSig).finish();

  return new SshWriter()
    .byte(SSH_MSG_USERAUTH_REQUEST)
    .string(user)
    .string('ssh-connection')
    .string('publickey')
    .bool(true)
    .string(ED25519_KEY_TYPE)
    .string(pk)
    .string(sigBlob)
    .finish();
}

export type UserAuthResult =
  | { type: 'success' }
  | { type: 'failure'; methods: string[]; partial: boolean }
  | { type: 'banner'; message: string }
  | { type: 'other'; msg: number };

export function parseUserAuthResult(payload: Uint8Array): UserAuthResult {
  const reader = new SshReader(payload);
  const msg = reader.byte();
  switch (msg) {
    case SSH_MSG_USERAUTH_SUCCESS:
      return { type: 'success' };
    case SSH_MSG_USERAUTH_FAILURE: {
      const methods = reader.nameList();
      const partial = reader.bool();
      return { type: 'failure', methods, partial };
    }
    case SSH_MSG_USERAUTH_BANNER: {
      const message = new TextDecoder().decode(reader.string());
      // language tag follows; ignored.
      return { type: 'banner', message };
    }
    default:
      return { type: 'other', msg };
  }
}
