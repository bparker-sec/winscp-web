import { describe, it, expect } from 'vitest';
import {
  encodePath,
  childrenUrl,
  itemUrl,
  contentUrl,
  uploadSessionUrl,
  parentChildrenUrl,
  driveItemToEntry,
  type DriveItem,
} from './graph';

describe('path encoding', () => {
  it('encodes segments but keeps slashes and drops leading slash', () => {
    expect(encodePath('/a b/c+d')).toBe('a%20b/c%2Bd');
    expect(encodePath('/')).toBe('');
    expect(encodePath('')).toBe('');
  });
});

describe('URL builders', () => {
  it('lists root vs nested children', () => {
    expect(childrenUrl('/')).toContain('/me/drive/root/children');
    expect(childrenUrl('/Docs')).toContain('/me/drive/root:/Docs:/children');
  });
  it('builds item, content, upload-session, parent-children urls', () => {
    expect(itemUrl('/')).toContain('/me/drive/root?');
    expect(itemUrl('/a/b')).toContain('/me/drive/root:/a/b?');
    expect(contentUrl('/a/b.txt')).toBe(
      'https://graph.microsoft.com/v1.0/me/drive/root:/a/b.txt:/content',
    );
    expect(uploadSessionUrl('/big.log')).toContain('/me/drive/root:/big.log:/createUploadSession');
    expect(parentChildrenUrl('/')).toContain('/me/drive/root/children');
    expect(parentChildrenUrl('/sub')).toContain('/me/drive/root:/sub:/children');
  });
});

describe('driveItemToEntry', () => {
  it('maps a folder', () => {
    const item: DriveItem = { id: '1', name: 'Docs', folder: { childCount: 2 } };
    const e = driveItemToEntry(item, '/Docs');
    expect(e).toMatchObject({ name: 'Docs', path: '/Docs', kind: 'dir' });
  });
  it('maps a file with size and mtime', () => {
    const item: DriveItem = {
      id: '2',
      name: 'a.txt',
      size: 12,
      file: { mimeType: 'text/plain' },
      lastModifiedDateTime: '2020-01-02T03:04:05Z',
    };
    const e = driveItemToEntry(item, '/a.txt');
    expect(e.kind).toBe('file');
    expect(e.size).toBe(12);
    expect(e.mtime).toBe(Date.parse('2020-01-02T03:04:05Z'));
  });
});
