import { describe, it, expect, vi, beforeEach } from 'vitest';
import { connectRemote, remoteTarget, isSshProtocol } from './connect';
import { connectSftp } from '../sftp/SftpConnection';
import { connectFtp } from '../ftp/FtpConnection';
import { connectWebdav } from '../webdav/WebDavConnection';
import { connectS3 } from '../s3/S3Connection';

vi.mock('../sftp/SftpConnection', () => ({ connectSftp: vi.fn(async () => ({ fs: {}, home: '/h', close: vi.fn() })) }));
vi.mock('../ftp/FtpConnection', () => ({ connectFtp: vi.fn(async () => ({ fs: {}, home: '/', close: vi.fn() })) }));
vi.mock('../webdav/WebDavConnection', () => ({ connectWebdav: vi.fn(async () => ({ fs: {}, home: '/', close: vi.fn() })) }));
vi.mock('../s3/S3Connection', () => ({ connectS3: vi.fn(async () => ({ fs: {}, home: '/', close: vi.fn() })) }));

const mSftp = connectSftp as unknown as ReturnType<typeof vi.fn>;
const mFtp = connectFtp as unknown as ReturnType<typeof vi.fn>;
const mWebdav = connectWebdav as unknown as ReturnType<typeof vi.fn>;
const mS3 = connectS3 as unknown as ReturnType<typeof vi.fn>;

describe('connectRemote dispatch', () => {
  beforeEach(() => {
    mSftp.mockClear();
    mFtp.mockClear();
    mWebdav.mockClear();
    mS3.mockClear();
  });

  it('routes sftp to connectSftp, passing trust/onClosed/channelWindow and stripping protocol', async () => {
    const trust = vi.fn();
    const onClosed = vi.fn();
    await connectRemote(
      { protocol: 'sftp', host: 'h', port: 22, username: 'u', password: 'p' },
      { trust, onClosed, channelWindow: 1234, label: 'lbl' },
    );
    expect(mSftp).toHaveBeenCalledTimes(1);
    const [creds, passedTrust, label, opts] = mSftp.mock.calls[0];
    expect(creds).toEqual({ host: 'h', port: 22, username: 'u', password: 'p' }); // no protocol
    expect(passedTrust).toBe(trust);
    expect(label).toBe('lbl');
    expect(opts).toEqual({ onClosed, channelWindow: 1234 });
  });

  it('routes ftp to connectFtp (no ssh trust/onClosed)', async () => {
    await connectRemote({ protocol: 'ftp', host: 'h', port: 21, username: 'u', password: 'p' }, {});
    expect(mFtp).toHaveBeenCalledTimes(1);
    expect(mFtp.mock.calls[0][0]).toEqual({ host: 'h', port: 21, username: 'u', password: 'p' });
  });

  it('routes webdav to connectWebdav', async () => {
    await connectRemote({ protocol: 'webdav', url: 'https://d/', username: 'u', password: 'p' }, {});
    expect(mWebdav).toHaveBeenCalledTimes(1);
    expect(mWebdav.mock.calls[0][0]).toEqual({ url: 'https://d/', username: 'u', password: 'p' });
  });

  it('routes s3 to connectS3', async () => {
    await connectRemote(
      { protocol: 's3', region: 'us-east-1', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's' },
      {},
    );
    expect(mS3).toHaveBeenCalledTimes(1);
    expect(mS3.mock.calls[0][0]).toMatchObject({ region: 'us-east-1', bucket: 'b', accessKeyId: 'a' });
  });
});

describe('remoteTarget / isSshProtocol', () => {
  it('formats a human target per protocol', () => {
    expect(remoteTarget({ protocol: 'sftp', host: 'h', port: 22, username: 'u' })).toBe('u@h:22');
    expect(remoteTarget({ protocol: 'ftp', host: 'h', port: 21, username: 'u', password: 'p' })).toBe('u@h:21');
    expect(remoteTarget({ protocol: 'webdav', url: 'https://dav.example.com/x' })).toBe('dav.example.com');
    expect(remoteTarget({ protocol: 's3', region: 'eu-west-1', bucket: 'mybucket', accessKeyId: 'a', secretAccessKey: 's' })).toBe(
      's3://mybucket (eu-west-1)',
    );
  });

  it('marks only sftp as an SSH protocol', () => {
    expect(isSshProtocol('sftp')).toBe(true);
    expect(isSshProtocol('ftp')).toBe(false);
    expect(isSshProtocol('webdav')).toBe(false);
    expect(isSshProtocol('s3')).toBe(false);
  });
});
