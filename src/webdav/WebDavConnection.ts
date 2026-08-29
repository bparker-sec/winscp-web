import { FsError, type FileSystem } from '../fs/FileSystem';
import { WebDavFS, buildBasicAuth } from './WebDavFS';

export interface WebDavCredentials {
  url: string;
  username?: string;
  password?: string;
}

export interface WebDavConnection {
  fs: FileSystem;
  /** Starting directory: the path portion of the base URL (defaults to "/"). */
  home: string;
  /** No-op: WebDAV is stateless HTTP with nothing to tear down. */
  close(): Promise<void>;
}

/**
 * Verify a WebDAV endpoint is reachable and the credentials authenticate, then
 * return a ready {@link WebDavFS}. Reachability/auth is checked with a Depth:0
 * PROPFIND against the base URL.
 */
export async function connectWebdav(
  creds: WebDavCredentials,
  label?: string,
): Promise<WebDavConnection> {
  const authHeader =
    creds.username !== undefined
      ? buildBasicAuth(creds.username, creds.password ?? '')
      : '';

  const parsed = new URL(creds.url);
  // The path portion becomes the filesystem's home; default to "/".
  const home = parsed.pathname && parsed.pathname !== '' ? parsed.pathname : '/';

  const fs = new WebDavFS(creds.url, authHeader, label ?? `WebDAV (${parsed.host})`);

  // Probe the base path to surface auth/connectivity errors up front.
  try {
    await fs.stat(home);
  } catch (e) {
    if (e instanceof FsError) throw e;
    throw new FsError('io', e instanceof Error ? e.message : String(e), e);
  }

  return {
    fs,
    home,
    async close() {},
  };
}
