import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebDavFS, buildBasicAuth } from './WebDavFS';
import { FsError } from '../fs/FileSystem';

const BASE = 'https://dav.example.com/dav/';
const AUTH = buildBasicAuth('alice', 'secret');

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function multistatus(
  entries: Array<{ href: string; dir?: boolean; size?: number; mtime?: string }>,
): string {
  const body = entries
    .map((e) => {
      const type = e.dir ? '<D:collection/>' : '';
      const len =
        e.size !== undefined ? `<D:getcontentlength>${e.size}</D:getcontentlength>` : '';
      const mod =
        e.mtime !== undefined ? `<D:getlastmodified>${e.mtime}</D:getlastmodified>` : '';
      return (
        `<D:response><D:href>${e.href}</D:href><D:propstat>` +
        `<D:prop><D:resourcetype>${type}</D:resourcetype>${len}${mod}</D:prop>` +
        `<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
      );
    })
    .join('');
  return `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${body}</D:multistatus>`;
}

function xmlResponse(body: string, status = 207): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/xml' },
  });
}

/** A Response whose body streams the given chunks one read() at a time. */
function streamingResponse(chunks: Uint8Array[], status = 200, headers?: HeadersInit): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return new Response(stream, { status, headers });
}

describe('WebDavFS.list', () => {
  it('parses files and dirs, excludes the self entry, and sorts', async () => {
    fetchMock.mockResolvedValueOnce(
      xmlResponse(
        multistatus([
          // Self entry for the requested collection — must be excluded.
          { href: '/dav/', dir: true },
          { href: '/dav/zeta.txt', size: 12, mtime: 'Wed, 27 Aug 2025 10:00:00 GMT' },
          { href: '/dav/Apps/', dir: true },
        ]),
      ),
    );

    const fs = new WebDavFS(BASE, AUTH);
    const entries = await fs.list('/dav/');

    expect(entries.map((e) => e.name)).toEqual(['Apps', 'zeta.txt']);
    expect(entries[0]).toMatchObject({ path: '/dav/Apps', kind: 'dir' });
    expect(entries[1]).toMatchObject({
      path: '/dav/zeta.txt',
      kind: 'file',
      size: 12,
      mtime: Date.parse('Wed, 27 Aug 2025 10:00:00 GMT'),
    });

    // Verify the request shape.
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://dav.example.com/dav/');
    expect(init.method).toBe('PROPFIND');
    expect(init.headers.Depth).toBe('1');
    expect(init.headers.Authorization).toBe(AUTH);
    expect(init.body).toContain('resourcetype');
  });

  it('encodes path segments and decodes names', async () => {
    fetchMock.mockResolvedValueOnce(
      xmlResponse(
        multistatus([
          { href: '/dav/my%20folder/', dir: true },
          { href: '/dav/my%20folder/a%20b.txt', size: 3 },
        ]),
      ),
    );
    const fs = new WebDavFS(BASE, AUTH);
    const entries = await fs.list('/dav/my folder');
    expect(fetchMock.mock.calls[0][0]).toBe('https://dav.example.com/dav/my%20folder');
    expect(entries.map((e) => e.name)).toEqual(['a b.txt']);
    expect(entries[0].path).toBe('/dav/my folder/a b.txt');
  });

  it('maps 404 to FsError not-found', async () => {
    fetchMock.mockResolvedValueOnce(xmlResponse('', 404));
    const fs = new WebDavFS(BASE, AUTH);
    await expect(fs.list('/dav/missing')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('maps 401 to FsError permission', async () => {
    fetchMock.mockResolvedValueOnce(xmlResponse('', 401));
    const fs = new WebDavFS(BASE, AUTH);
    const err = await fs.list('/dav/x').catch((e) => e);
    expect(err).toBeInstanceOf(FsError);
    expect(err.code).toBe('permission');
  });
});

describe('WebDavFS.stat', () => {
  it('returns the single response entry', async () => {
    fetchMock.mockResolvedValueOnce(
      xmlResponse(
        multistatus([
          { href: '/dav/notes.txt', size: 5, mtime: 'Wed, 27 Aug 2025 10:00:00 GMT' },
        ]),
      ),
    );
    const fs = new WebDavFS(BASE, AUTH);
    const entry = await fs.stat('/dav/notes.txt');
    expect(entry).toMatchObject({ name: 'notes.txt', kind: 'file', size: 5 });
    expect(fetchMock.mock.calls[0][1].headers.Depth).toBe('0');
  });
});

describe('WebDavFS.mkdir', () => {
  it('succeeds on 201', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 201 }));
    const fs = new WebDavFS(BASE, AUTH);
    await expect(fs.mkdir('/dav/new')).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][1].method).toBe('MKCOL');
  });

  it('maps 405 to exists when the target already exists', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 405 })) // MKCOL
      .mockResolvedValueOnce(xmlResponse(multistatus([{ href: '/dav/dup/', dir: true }]))); // stat probe
    const fs = new WebDavFS(BASE, AUTH);
    await expect(fs.mkdir('/dav/dup')).rejects.toMatchObject({ code: 'exists' });
  });

  it('maps 409 to io when the parent is missing (probe 404s)', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 409 })) // MKCOL
      .mockResolvedValueOnce(xmlResponse('', 404)); // stat probe -> not found
    const fs = new WebDavFS(BASE, AUTH);
    await expect(fs.mkdir('/dav/a/b')).rejects.toMatchObject({ code: 'io' });
  });
});

describe('WebDavFS.remove', () => {
  it('deletes recursively without a guard PROPFIND', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const fs = new WebDavFS(BASE, AUTH);
    await fs.remove('/dav/dir', true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
  });

  it('throws not-empty for a non-empty dir when recursive=false', async () => {
    fetchMock.mockResolvedValueOnce(
      xmlResponse(
        multistatus([
          { href: '/dav/dir/', dir: true },
          { href: '/dav/dir/child.txt', size: 1 },
        ]),
      ),
    );
    const fs = new WebDavFS(BASE, AUTH);
    await expect(fs.remove('/dav/dir', false)).rejects.toMatchObject({ code: 'not-empty' });
    // Only the guard PROPFIND ran; no DELETE.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].method).toBe('PROPFIND');
  });

  it('deletes an empty dir when recursive=false', async () => {
    fetchMock
      .mockResolvedValueOnce(xmlResponse(multistatus([{ href: '/dav/empty/', dir: true }])))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const fs = new WebDavFS(BASE, AUTH);
    await fs.remove('/dav/empty', false);
    expect(fetchMock.mock.calls[1][1].method).toBe('DELETE');
  });
});

describe('WebDavFS.move', () => {
  it('sends MOVE with an absolute Destination and Overwrite', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 201 }));
    const fs = new WebDavFS(BASE, AUTH);
    await fs.move('/dav/a.txt', '/dav/sub/b c.txt');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://dav.example.com/dav/a.txt');
    expect(init.method).toBe('MOVE');
    expect(init.headers.Destination).toBe('https://dav.example.com/dav/sub/b%20c.txt');
    expect(init.headers.Overwrite).toBe('T');
  });
});

describe('WebDavFS.openRead', () => {
  it('assembles bytes across reader chunks and returns 0 at EOF', async () => {
    fetchMock.mockResolvedValueOnce(
      streamingResponse(
        [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])],
        200,
        { 'Content-Length': '5' },
      ),
    );
    const fs = new WebDavFS(BASE, AUTH);
    const handle = await fs.openRead('/dav/file.bin');
    expect(handle.size).toBe(5);

    const got: number[] = [];
    const buf = new Uint8Array(2);
    for (;;) {
      const n = await handle.read(buf);
      if (n === 0) break;
      got.push(...buf.subarray(0, n));
    }
    expect(got).toEqual([1, 2, 3, 4, 5]);
    await handle.close();
  });

  it('sends a Range header when offset > 0 and reads size from Content-Range', async () => {
    fetchMock.mockResolvedValueOnce(
      streamingResponse([new Uint8Array([9, 9])], 206, {
        'Content-Range': 'bytes 3-4/5',
      }),
    );
    const fs = new WebDavFS(BASE, AUTH);
    const handle = await fs.openRead('/dav/file.bin', 3);
    expect(fetchMock.mock.calls[0][1].headers.Range).toBe('bytes=3-');
    expect(handle.size).toBe(5);
    const buf = new Uint8Array(8);
    expect(await handle.read(buf)).toBe(2);
  });

  it('discards leading bytes when the server ignores Range (200 not 206)', async () => {
    fetchMock.mockResolvedValueOnce(
      streamingResponse([new Uint8Array([1, 2, 3, 4, 5])], 200, {
        'Content-Length': '5',
      }),
    );
    const fs = new WebDavFS(BASE, AUTH);
    const handle = await fs.openRead('/dav/file.bin', 2);
    const got: number[] = [];
    const buf = new Uint8Array(8);
    for (;;) {
      const n = await handle.read(buf);
      if (n === 0) break;
      got.push(...buf.subarray(0, n));
    }
    expect(got).toEqual([3, 4, 5]);
  });
});

describe('WebDavFS.openWrite', () => {
  it('buffers chunks and PUTs the concatenated body on close', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 201 }));
    const fs = new WebDavFS(BASE, AUTH);
    const handle = await fs.openWrite('/dav/up.bin');
    expect(handle.startOffset).toBe(0);
    await handle.write(new Uint8Array([1, 2]));
    await handle.write(new Uint8Array([3, 4, 5]));
    await handle.close();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://dav.example.com/dav/up.bin');
    expect(init.method).toBe('PUT');
    const bodyBytes = new Uint8Array(await new Response(init.body).arrayBuffer());
    expect([...bodyBytes]).toEqual([1, 2, 3, 4, 5]);
  });

  it('abort discards the buffer and issues no PUT', async () => {
    const fs = new WebDavFS(BASE, AUTH);
    const handle = await fs.openWrite('/dav/up.bin');
    await handle.write(new Uint8Array([1, 2, 3]));
    await handle.abort();
    await handle.close(); // close after abort must stay a no-op
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a failed PUT status to an FsError', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }));
    const fs = new WebDavFS(BASE, AUTH);
    const handle = await fs.openWrite('/dav/up.bin');
    await handle.write(new Uint8Array([1]));
    await expect(handle.close()).rejects.toMatchObject({ code: 'permission' });
  });
});

describe('buildBasicAuth', () => {
  it('builds a Basic header from user:pass', () => {
    // base64("alice:secret")
    expect(buildBasicAuth('alice', 'secret')).toBe('Basic YWxpY2U6c2VjcmV0');
  });
});
