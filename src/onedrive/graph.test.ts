import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  encodePath,
  childrenUrl,
  itemUrl,
  contentUrl,
  uploadSessionUrl,
  parentChildrenUrl,
  driveItemToEntry,
  listChildren,
  getItem,
  GraphError,
  deleteItem,
  getUploadSessionStatus,
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

describe('graphFetch network behavior', () => {
  const auth = (tokens: string[]) => {
    let i = 0;
    return { getToken: vi.fn(async () => tokens[Math.min(i++, tokens.length - 1)] ?? null) };
  };
  afterEach(() => vi.restoreAllMocks());

  it('follows @odata.nextLink pagination', async () => {
    const pages = [
      { value: [{ id: '1', name: 'a' }], '@odata.nextLink': 'https://next' },
      { value: [{ id: '2', name: 'b' }] },
    ];
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({ ok: true, status: 200, json: async () => pages[call++] }) as unknown as Response,
      ),
    );
    const items = await listChildren(auth(['T']), '/');
    expect(items.map((i) => i.name)).toEqual(['a', 'b']);
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(2);
  });

  it('retries once with a fresh token on 401', async () => {
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        n++;
        if (n === 1) {
          return {
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
            json: async () => ({}),
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: '1',
            name: 'x',
            __auth: (init.headers as Record<string, string>).Authorization,
          }),
        } as unknown as Response;
      }),
    );
    const item = await getItem(auth(['STALE', 'FRESH']), '/x');
    expect(item.name).toBe('x');
    const calls = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } })
      .mock.calls;
    expect(calls.length).toBe(2);
    expect((calls[1][1].headers as Record<string, string>).Authorization).toContain('FRESH');
  });

  it('throws GraphError on a non-ok, non-401 response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 404,
            statusText: 'Not Found',
            json: async () => ({ error: { message: 'gone' } }),
          }) as unknown as Response,
      ),
    );
    await expect(getItem(auth(['T']), '/missing')).rejects.toBeInstanceOf(GraphError);
  });

  it('refuses to delete the drive root', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await expect(deleteItem(auth(['T']), '/')).rejects.toMatchObject({ status: 400 });
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0);
  });
});

describe('getUploadSessionStatus', () => {
  afterEach(() => vi.restoreAllMocks());

  it('parses the start of the first nextExpectedRanges entry, unauthenticated', async () => {
    const fetchMock = vi.fn(
      async (_url?: string, _init?: RequestInit) =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ nextExpectedRanges: ['327680-'] }),
        }) as unknown as Response,
    );
    vi.stubGlobal('fetch', fetchMock);
    const status = await getUploadSessionStatus('https://upload');
    expect(status).toEqual({ nextOffset: 327680 });
    // No Authorization header: the uploadUrl is pre-authenticated.
    const init = fetchMock.mock.calls[0][1];
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
  });

  it('handles a bounded range "start-end"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            json: async () => ({ nextExpectedRanges: ['1000-2000'] }),
          }) as unknown as Response,
      ),
    );
    const status = await getUploadSessionStatus('https://upload');
    expect(status).toEqual({ nextOffset: 1000 });
  });

  it('returns null when the session is gone (non-ok response)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response),
    );
    const status = await getUploadSessionStatus('https://upload');
    expect(status).toBeNull();
  });

  it('returns null when the response has no usable nextExpectedRanges', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({ ok: true, status: 200, json: async () => ({ nextExpectedRanges: [] }) }) as unknown as Response,
      ),
    );
    const status = await getUploadSessionStatus('https://upload');
    expect(status).toBeNull();
  });

  it('returns null on network/parse failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    const status = await getUploadSessionStatus('https://upload');
    expect(status).toBeNull();
  });
});
