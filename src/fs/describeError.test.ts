import { describe, expect, it } from 'vitest';
import { FsError } from './FileSystem';
import { SftpTimeoutError } from '../sftp/SftpClient';
import { describeError } from './describeError';

describe('describeError', () => {
  it('maps FsError codes to human-readable text', () => {
    expect(describeError(new FsError('not-found', 'not-found'))).toBe('No such file or directory');
    expect(describeError(new FsError('permission', 'permission'))).toBe('Permission denied');
    expect(describeError(new FsError('exists', 'exists'))).toBe('Already exists');
    expect(describeError(new FsError('not-empty', 'not-empty'))).toBe('Directory is not empty');
    expect(describeError(new FsError('not-a-file', 'not-a-file'))).toBe('Not a file');
    expect(describeError(new FsError('not-a-directory', 'not-a-directory'))).toBe('Not a directory');
    expect(describeError(new FsError('unsupported', 'unsupported'))).toBe('Operation not supported');
  });

  it('appends extra detail from the original message when present', () => {
    expect(describeError(new FsError('not-found', '/tmp/missing.txt'))).toBe(
      'No such file or directory (/tmp/missing.txt)',
    );
  });

  it('uses the io error message when it looks human, else falls back', () => {
    expect(describeError(new FsError('io', 'Disk is full'))).toBe('Disk is full');
    expect(describeError(new FsError('io', 'SshChannel_write_ECONNRESET'))).toBe('I/O error');
  });

  it('maps SftpTimeoutError to a friendly timeout message', () => {
    expect(describeError(new SftpTimeoutError())).toBe('Operation timed out — the server did not respond.');
  });

  it('falls back to the message for a generic Error', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });

  it('stringifies non-Error values', () => {
    expect(describeError('just a string')).toBe('just a string');
    expect(describeError(42)).toBe('42');
  });
});
