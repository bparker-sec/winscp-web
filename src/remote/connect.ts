// A uniform entry point for opening a remote connection over any supported
// protocol. Each adapter already returns a {fs, home, close} shape; this
// dispatches on a tagged `protocol` discriminator and normalizes the result to
// `RemoteConnection`, so the app's connect flow is protocol-agnostic. The SFTP
// branch is passed through unchanged (host-key trust, channel window, and the
// connection-lost callback) so the validated SFTP path is untouched.

import type { FileSystem } from '../fs/FileSystem';
import type { TrustCallback } from '../ssh/SshClient';
import { connectSftp, type SftpCredentials } from '../sftp/SftpConnection';
import { connectFtp, type FtpCredentials } from '../ftp/FtpConnection';
import { connectWebdav, type WebDavCredentials } from '../webdav/WebDavConnection';
import { connectS3, type S3Credentials } from '../s3/S3Connection';

export type RemoteProtocol = 'sftp' | 'ftp' | 'webdav' | 's3';

export type RemoteCredentials =
  | ({ protocol: 'sftp' } & SftpCredentials)
  | ({ protocol: 'ftp' } & FtpCredentials)
  | ({ protocol: 'webdav' } & WebDavCredentials)
  | ({ protocol: 's3' } & S3Credentials);

export interface RemoteConnection {
  fs: FileSystem;
  home: string;
  close(): Promise<void>;
  /** Present only for SSH-based (SFTP) connections. */
  fingerprint?: string;
}

export interface ConnectRemoteOptions {
  /** SFTP host-key trust prompt. Ignored by non-SSH protocols. */
  trust?: TrustCallback;
  /** SFTP unexpected-connection-loss signal. Ignored by non-SSH protocols. */
  onClosed?: (reason: string) => void;
  /** SFTP channel receive-window in bytes. Ignored by non-SSH protocols. */
  channelWindow?: number;
  label?: string;
}

/** True when a protocol carries an SSH host key that TOFU/auto-reconnect applies to. */
export function isSshProtocol(protocol: RemoteProtocol): boolean {
  return protocol === 'sftp';
}

/** A short human label for the connection target (for logs and pane headers). */
export function remoteTarget(creds: RemoteCredentials): string {
  switch (creds.protocol) {
    case 'sftp':
    case 'ftp':
      return `${creds.username}@${creds.host}:${creds.port}`;
    case 'webdav':
      try {
        return new URL(creds.url).host;
      } catch {
        return creds.url;
      }
    case 's3':
      return `s3://${creds.bucket} (${creds.region})`;
  }
}

/** Open a remote connection for any supported protocol. */
export async function connectRemote(
  creds: RemoteCredentials,
  opts: ConnectRemoteOptions = {},
): Promise<RemoteConnection> {
  switch (creds.protocol) {
    case 'sftp': {
      const { protocol: _p, ...c } = creds;
      return connectSftp(c, opts.trust, opts.label, {
        onClosed: opts.onClosed,
        channelWindow: opts.channelWindow,
      });
    }
    case 'ftp': {
      const { protocol: _p, ...c } = creds;
      return connectFtp(c, opts.label);
    }
    case 'webdav': {
      const { protocol: _p, ...c } = creds;
      return connectWebdav(c, opts.label);
    }
    case 's3': {
      const { protocol: _p, ...c } = creds;
      return connectS3(c, opts.label);
    }
  }
}
