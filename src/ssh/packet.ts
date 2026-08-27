import type { ByteStream } from '../net/ByteStream';
import { gcmSeal, gcmOpen, incrementGcmIv } from './crypto/aesgcm';

/**
 * Cipher used for one direction of the Binary Packet Protocol. "none" is used
 * from identification through NEWKEYS; a GCM cipher replaces it afterwards.
 * The BPP block size differs (8 for none, 16 for GCM AEAD), which is why the
 * padding math in encodePacket/readPacket branches on `kind`.
 */
export type Cipher = NoneCipher | GcmCipher;

/** Cleartext cipher (RFC 4253 §6): no encryption, no MAC, 8-byte block size. */
export class NoneCipher {
  readonly kind = 'none' as const;
}

/**
 * aes*-gcm@openssh.com cipher (RFC 5647): AEAD with the cleartext
 * packet_length as AAD, 16-byte block size, 16-byte tag. The 12-byte IV is
 * fixed(4)||counter(8); the counter increments after every packet processed
 * (sealed or opened) in this direction.
 */
export class GcmCipher {
  readonly kind = 'gcm' as const;
  constructor(
    private readonly key: Uint8Array,
    private readonly iv: Uint8Array,
  ) {}

  seal(aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    const ct = gcmSeal(this.key, this.iv, aad, plaintext);
    incrementGcmIv(this.iv);
    return ct;
  }

  open(aad: Uint8Array, ciphertextAndTag: Uint8Array): Uint8Array {
    const pt = gcmOpen(this.key, this.iv, aad, ciphertextAndTag);
    incrementGcmIv(this.iv);
    return pt;
  }
}

const GCM_TAG_LEN = 16;

// OpenSSH's PACKET_MAX_SIZE. Reject larger lengths before buffering (anti-DoS).
const MAX_PACKET_LENGTH = 256 * 1024;

/** Compute a padding length >= 4 such that `base + padding` is a multiple of `blockSize`. */
function paddingLengthFor(base: number, blockSize: number): number {
  let padding = blockSize - (base % blockSize);
  if (padding < 4) padding += blockSize;
  return padding;
}

/**
 * Encode one SSH packet for the wire (RFC 4253 §6 / RFC 5647). `seq` is the
 * per-direction packet sequence number; it isn't used by "none" or GCM
 * framing itself but is accepted for a uniform Cipher-agnostic call site
 * (future MAC-based ciphers need it in the MAC input).
 */
export function encodePacket(payload: Uint8Array, cipher: Cipher, seq: number): Uint8Array {
  void seq;
  if (cipher.kind === 'none') {
    // (4 + packet_length) must be a multiple of 8, where packet_length = 1 + payload + padding.
    const paddingLength = paddingLengthFor(5 + payload.length, 8);
    const packetLength = 1 + payload.length + paddingLength;
    const out = new Uint8Array(4 + packetLength);
    new DataView(out.buffer).setUint32(0, packetLength);
    out[4] = paddingLength;
    out.set(payload, 5);
    // padding left as zeros (RFC allows any bytes; zeros keep tests deterministic).
    return out;
  }

  // GCM: (1 + payload + padding) must be a multiple of 16; packet_length is cleartext AAD.
  const paddingLength = paddingLengthFor(1 + payload.length, 16);
  const packetLength = 1 + payload.length + paddingLength;
  const lengthBytes = new Uint8Array(4);
  new DataView(lengthBytes.buffer).setUint32(0, packetLength);

  const plaintext = new Uint8Array(packetLength);
  plaintext[0] = paddingLength;
  plaintext.set(payload, 1);
  // padding left as zeros.

  const ciphertextAndTag = cipher.seal(lengthBytes, plaintext);
  const out = new Uint8Array(4 + ciphertextAndTag.length);
  out.set(lengthBytes, 0);
  out.set(ciphertextAndTag, 4);
  return out;
}

/** Read and decode one SSH packet from the stream, returning the payload (padding stripped). */
export async function readPacket(stream: ByteStream, cipher: Cipher, seq: number): Promise<Uint8Array> {
  void seq;
  const lengthBytes = await stream.readExactly(4);
  const packetLength = new DataView(lengthBytes.buffer, lengthBytes.byteOffset, 4).getUint32(0);
  if (packetLength < 1 || packetLength > MAX_PACKET_LENGTH) {
    throw new Error(`SSH packet length out of range: ${packetLength}`);
  }

  if (cipher.kind === 'none') {
    const body = await stream.readExactly(packetLength);
    const paddingLength = body[0];
    if (paddingLength < 4 || paddingLength > packetLength - 1) {
      throw new Error(`SSH padding_length out of range: ${paddingLength}`);
    }
    const payloadLength = packetLength - 1 - paddingLength;
    return body.subarray(1, 1 + payloadLength);
  }

  const ciphertextAndTag = await stream.readExactly(packetLength + GCM_TAG_LEN);
  const plaintext = cipher.open(lengthBytes, ciphertextAndTag);
  const paddingLength = plaintext[0];
  // gcmOpen has already authenticated these bytes, but an authenticated peer can
  // still send a malformed padding_length, so validate before slicing.
  if (paddingLength < 4 || paddingLength > packetLength - 1) {
    throw new Error(`SSH padding_length out of range: ${paddingLength}`);
  }
  const payloadLength = packetLength - 1 - paddingLength;
  return plaintext.subarray(1, 1 + payloadLength);
}
