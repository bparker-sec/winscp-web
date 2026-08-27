import { sha256 } from '@noble/hashes/sha2';
import { concatBytes } from '@noble/hashes/utils';

export type HashFn = (data: Uint8Array) => Uint8Array;

/**
 * RFC 4253 §7.2 key derivation. `kMpint` is the shared secret already encoded as
 * an SSH mpint (length-prefixed). `letter` is 'A'..'F'. Returns `needed` bytes.
 */
export function deriveKey(
  kMpint: Uint8Array,
  h: Uint8Array,
  letter: 'A' | 'B' | 'C' | 'D' | 'E' | 'F',
  sessionId: Uint8Array,
  needed: number,
  hash: HashFn = sha256,
): Uint8Array {
  let block = hash(concatBytes(kMpint, h, Uint8Array.of(letter.charCodeAt(0)), sessionId));
  let key = block;
  while (key.length < needed) {
    block = hash(concatBytes(kMpint, h, key));
    key = concatBytes(key, block);
  }
  return key.subarray(0, needed).slice();
}
