import { FsError, type FsErrorCode } from './FileSystem';
import { SftpTimeoutError } from '../sftp/SftpClient';

const FS_ERROR_MESSAGES: Record<FsErrorCode, string> = {
  'not-found': 'No such file or directory',
  permission: 'Permission denied',
  exists: 'Already exists',
  'not-empty': 'Directory is not empty',
  'not-a-file': 'Not a file',
  'not-a-directory': 'Not a directory',
  unsupported: 'Operation not supported',
  io: 'I/O error',
};

/**
 * Looks like a message a human wrote (has spaces, isn't just an error code /
 * stack-trace-shaped token) rather than something like "SshChannel cannot write".
 * This is a soft heuristic used only to decide whether to surface an 'io'
 * error's own message instead of the generic fallback.
 */
function looksHuman(message: string): boolean {
  return /\s/.test(message.trim()) && message.length < 200;
}

/**
 * Turn any thrown value into a short, human-readable string suitable for
 * surfacing directly in the UI (action-error banners, transfer job errors,
 * diagnostics). Never returns raw protocol/internal strings like "SshChannel
 * cannot write" when a clearer mapping is available.
 */
export function describeError(e: unknown): string {
  if (e instanceof FsError) {
    const base = FS_ERROR_MESSAGES[e.code] ?? e.message;
    if (e.code === 'io') {
      return looksHuman(e.message) ? e.message : base;
    }
    // Append the original message when it adds detail beyond the code itself.
    if (e.message && e.message !== e.code && e.message !== base) {
      return `${base} (${e.message})`;
    }
    return base;
  }

  if (e instanceof SftpTimeoutError) {
    return 'Operation timed out — the server did not respond.';
  }

  if (e instanceof Error) {
    return e.message;
  }

  return String(e);
}
