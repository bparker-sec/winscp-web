import type { ByteStream } from '../net/ByteStream';

/** Our client identification string (RFC 4253 §4.2), sent without the trailing CRLF. */
export const CLIENT_ID = 'SSH-2.0-WebSCP_1.0';

/** Maximum non-"SSH-" preamble lines we'll tolerate before giving up (guards against a hostile/broken peer). */
const MAX_PREAMBLE_LINES = 50;

export interface IdentificationResult {
  clientId: string;
  serverId: string;
}

/**
 * Perform the SSH identification-string exchange (RFC 4253 §4.2): send our
 * banner, then read lines until we see one starting with "SSH-" (ignoring any
 * preceding lines, which servers may send before the version string).
 */
export async function exchangeIdentification(stream: ByteStream): Promise<IdentificationResult> {
  await stream.write(new TextEncoder().encode(CLIENT_ID + '\r\n'));

  for (let i = 0; i < MAX_PREAMBLE_LINES; i++) {
    const line = await stream.readLine();
    if (line.startsWith('SSH-')) {
      return { clientId: CLIENT_ID, serverId: line };
    }
  }
  throw new Error('Too many lines received before an SSH identification banner.');
}
