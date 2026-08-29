import { describe, it, expect, vi, beforeEach } from 'vitest';
import { S3FS, type S3Config } from './S3FS';
import { FsError } from '../fs/FileSystem';

const cfg: S3Config = {
  region: 'us-east-1',
  bucket: 'my-bucket',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};

/** Minimal Response-like object for the fetch mock. */
function mockResponse(opts: {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  bytes?: Uint8Array;
}) {
  const status = opts.status ?? 200;
  const headers = new Headers(opts.headers ?? {});
  let streamed = false;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    async text() {
      return opts.body ?? '';
    },
    async arrayBuffer() {
      return (opts.bytes ?? new Uint8Array(0)).buffer;
    },
    get body(): ReadableStream<Uint8Array> | null {
      const bytes = opts.bytes;
      if (!bytes) return null;
      return {
        getReader() {
          return {
            async read() {
              if (streamed) return { done: true, value: undefined };
              streamed = true;
              return { done: false, value: bytes };
            },
            async cancel() {},
          };
        },
      } as unknown as ReadableStream<Uint8Array>;
    },
  };
}

const LIST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>my-bucket</Name>
  <Prefix>docs/</Prefix>
  <Delimiter>/</Delimiter>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>docs/</Key>
    <LastModified>2024-01-01T00:00:00.000Z</LastModified>
    <Size>0</Size>
  </Contents>
  <Contents>
    <Key>docs/report.pdf</Key>
    <LastModified>2024-02-03T10:20:30.000Z</LastModified>
    <Size>2048</Size>
  </Contents>
  <Contents>
    <Key>docs/notes.txt</Key>
    <LastModified>2024-02-04T00:00:00.000Z</LastModified>
    <Size>10</Size>
  </Contents>
  <CommonPrefixes>
    <Prefix>docs/images/</Prefix>
  </CommonPrefixes>
</ListBucketResult>`;

let fetchMock: ReturnType<typeof vi.fn>;

function makeFs(): S3FS {
  return new S3FS(cfg, undefined, fetchMock as unknown as typeof fetch);
}

beforeEach(() => {
  fetchMock = vi.fn();
});

describe('S3FS.list', () => {
  it('parses CommonPrefixes as dirs and Contents as files, excluding the folder marker', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ body: LIST_XML }));
    const fs = makeFs();
    const entries = await fs.list('/docs');

    // Folders first (sortEntries), then files alphabetically.
    expect(entries.map((e) => `${e.kind}:${e.name}`)).toEqual([
      'dir:images',
      'file:notes.txt',
      'file:report.pdf',
    ]);
    // The `docs/` folder marker is excluded.
    expect(entries.find((e) => e.name === 'docs')).toBeUndefined();

    const report = entries.find((e) => e.name === 'report.pdf')!;
    expect(report.path).toBe('/docs/report.pdf');
    expect(report.size).toBe(2048);
    expect(report.mtime).toBe(Date.parse('2024-02-03T10:20:30.000Z'));

    // Verify it was a list-type=2 request with the right prefix and delimiter.
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('list-type=2');
    expect(url).toContain('delimiter=%2F');
    expect(url).toContain('prefix=docs%2F');
  });
});

describe('S3FS.stat', () => {
  it('stats a file via HEAD', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        status: 200,
        headers: { 'content-length': '1234', 'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT' },
      }),
    );
    const fs = makeFs();
    const entry = await fs.stat('/docs/report.pdf');
    expect(entry.kind).toBe('file');
    expect(entry.size).toBe(1234);
    expect(entry.mtime).toBe(Date.parse('Wed, 21 Oct 2015 07:28:00 GMT'));
    expect(fetchMock.mock.calls[0][1].method).toBe('HEAD');
  });

  it('falls back to a prefix check for a directory', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ status: 404 })) // HEAD miss
      .mockResolvedValueOnce(mockResponse({ body: LIST_XML })); // prefix has contents
    const fs = makeFs();
    const entry = await fs.stat('/docs');
    expect(entry.kind).toBe('dir');
    expect(entry.path).toBe('/docs');
  });
});

describe('S3FS.mkdir', () => {
  it('writes a `/`-suffixed zero-byte marker when the prefix is empty', async () => {
    fetchMock
      .mockResolvedValueOnce(
        mockResponse({
          body: `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>`,
        }),
      ) // existence check: no Contents
      .mockResolvedValueOnce(mockResponse({ status: 200 })); // PUT marker
    const fs = makeFs();
    await fs.mkdir('/newdir');

    const putCall = fetchMock.mock.calls[1];
    expect(putCall[1].method).toBe('PUT');
    expect(putCall[0]).toContain('/newdir/');
  });

  it('throws exists when keys already live under the prefix', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ body: LIST_XML }));
    const fs = makeFs();
    await expect(fs.mkdir('/docs')).rejects.toMatchObject({ code: 'exists' });
  });
});

describe('S3FS.remove', () => {
  it('deletes a single file (HEAD hit, then DELETE)', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ status: 200, headers: { 'content-length': '5' } })) // HEAD
      .mockResolvedValueOnce(mockResponse({ status: 204 })); // DELETE
    const fs = makeFs();
    await fs.remove('/docs/notes.txt', false);
    expect(fetchMock.mock.calls[1][1].method).toBe('DELETE');
  });

  it('recursively deletes every key under a directory prefix', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ status: 404 })) // HEAD miss -> it's a dir
      .mockResolvedValueOnce(mockResponse({ body: LIST_XML })) // listAllKeys
      .mockResolvedValue(mockResponse({ status: 204 })); // DELETEs
    const fs = makeFs();
    await fs.remove('/docs', true);

    const deletes = fetchMock.mock.calls.filter((c) => c[1].method === 'DELETE');
    // docs/, docs/report.pdf, docs/notes.txt => 3 deletes.
    expect(deletes.length).toBe(3);
  });

  it('refuses a non-empty directory without recursive', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ status: 404 })) // HEAD miss
      .mockResolvedValueOnce(mockResponse({ body: LIST_XML })); // has children
    const fs = makeFs();
    await expect(fs.remove('/docs', false)).rejects.toMatchObject({ code: 'not-empty' });
  });
});

describe('S3FS.rename/move', () => {
  it('copies then deletes a single file', async () => {
    fetchMock
      .mockResolvedValueOnce(
        mockResponse({
          body: `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>`,
        }),
      ) // isPrefix -> not a dir
      .mockResolvedValueOnce(mockResponse({ status: 200 })) // PUT copy
      .mockResolvedValueOnce(mockResponse({ status: 204 })); // DELETE source
    const fs = makeFs();
    await fs.rename('/docs/a.txt', '/docs/b.txt');

    const copy = fetchMock.mock.calls[1];
    expect(copy[1].method).toBe('PUT');
    expect(copy[0]).toContain('/docs/b.txt');
    expect(copy[1].headers['x-amz-copy-source']).toBe('/my-bucket/docs/a.txt');
    expect(fetchMock.mock.calls[2][1].method).toBe('DELETE');
  });
});

describe('S3FS.openRead', () => {
  it('assembles bytes from the streamed body', async () => {
    const payload = new TextEncoder().encode('hello world');
    fetchMock.mockResolvedValueOnce(
      mockResponse({ status: 200, headers: { 'content-length': '11' }, bytes: payload }),
    );
    const fs = makeFs();
    const handle = await fs.openRead('/docs/notes.txt');
    expect(handle.size).toBe(11);

    const into = new Uint8Array(4);
    const collected: number[] = [];
    let n: number;
    while ((n = await handle.read(into)) > 0) {
      for (let i = 0; i < n; i++) collected.push(into[i]);
    }
    await handle.close();
    expect(new TextDecoder().decode(new Uint8Array(collected))).toBe('hello world');
  });

  it('sends a Range header when given an offset', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        status: 206,
        headers: { 'content-range': 'bytes 5-10/11', 'content-length': '6' },
        bytes: new TextEncoder().encode(' world'),
      }),
    );
    const fs = makeFs();
    const handle = await fs.openRead('/docs/notes.txt', 5);
    expect(handle.size).toBe(11); // from Content-Range total
    expect(fetchMock.mock.calls[0][1].headers['Range']).toBe('bytes=5-');
  });
});

describe('S3FS.openWrite', () => {
  it('buffers chunks and PUTs the whole body on close', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 200 }));
    const fs = makeFs();
    const handle = await fs.openWrite('/docs/out.txt');
    expect(handle.startOffset).toBe(0);
    await handle.write(new TextEncoder().encode('foo'));
    await handle.write(new TextEncoder().encode('bar'));
    // Nothing sent until close.
    expect(fetchMock).not.toHaveBeenCalled();
    await handle.close();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const put = fetchMock.mock.calls[0];
    expect(put[1].method).toBe('PUT');
    expect(new TextDecoder().decode(put[1].body)).toBe('foobar');
  });

  it('abort discards the buffer and sends nothing', async () => {
    const fs = makeFs();
    const handle = await fs.openWrite('/docs/out.txt');
    await handle.write(new TextEncoder().encode('data'));
    await handle.abort();
    await handle.close();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('S3FS error mapping', () => {
  it('maps 404 to FsError not-found', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({ status: 404, body: '<Error><Code>NoSuchKey</Code></Error>' }),
    );
    const fs = makeFs();
    await expect(fs.list('/missing')).rejects.toBeInstanceOf(FsError);
    fetchMock.mockResolvedValueOnce(
      mockResponse({ status: 404, body: '<Error><Code>NoSuchKey</Code></Error>' }),
    );
    await expect(fs.list('/missing')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('maps 403 to FsError permission', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({ status: 403, body: '<Error><Code>AccessDenied</Code></Error>' }),
    );
    const fs = makeFs();
    await expect(fs.list('/secret')).rejects.toMatchObject({ code: 'permission' });
  });
});
