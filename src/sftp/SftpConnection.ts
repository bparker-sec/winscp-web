// SftpConnection: glues tcpConnect -> SshClient -> SftpClient -> SftpFS into a
// single FileSystem-producing entry point for the app.

import { tcpConnect } from '../sdk/tcp';
import { ByteStream } from '../net/ByteStream';
import { SshClient, type TrustCallback } from '../ssh/SshClient';
import { SftpClient } from './SftpClient';
import { SftpFS } from './SftpFS';
import type { FileSystem } from '../fs/FileSystem';

export interface SftpCredentials {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: { seed: Uint8Array; publicKey: Uint8Array };
}

export interface SftpConnection {
  fs: FileSystem;
  fingerprint: string;
  home: string;
  close(): Promise<void>;
}

/**
 * Connect to an SFTP server end-to-end: TCP (via the host proxy) -> SSH
 * transport/auth -> the `sftp` subsystem -> a ready-to-use `FileSystem`.
 */
export async function connectSftp(
  creds: SftpCredentials,
  trust?: TrustCallback,
  label?: string,
  opts?: { onClosed?: (reason: string) => void; channelWindow?: number },
): Promise<SftpConnection> {
  const { host, port, username } = creds;

  const tcpResult = await tcpConnect(host, port);
  if (!tcpResult.ok || !tcpResult.socket) {
    throw new Error(`Failed to connect to ${host}:${port}: ${tcpResult.detail ?? 'unknown error'}`);
  }

  const stream = new ByteStream(tcpResult.socket);
  const ssh = new SshClient(stream, { host, port, onClosed: opts?.onClosed });

  const { fingerprint } = await ssh.connect(trust);
  await ssh.authenticate({
    username,
    password: creds.password,
    privateKey: creds.privateKey,
  });

  const channel = await ssh.openSubsystem('sftp', { window: opts?.channelWindow });
  const client = new SftpClient(channel);
  await client.init();
  const home = await client.realpath('.');

  const fs = new SftpFS(client, label ?? `${username}@${host}`);

  return {
    fs,
    fingerprint,
    home,
    close: () => ssh.disconnect(),
  };
}
