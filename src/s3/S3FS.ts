// FileSystem implementation over the Amazon S3 REST API (and S3-compatible
// stores), signing every request with AWS Signature Version 4 over the global
// `fetch`.
//
// S3 is a flat key/value store; directories are modeled with the conventional
// `/`-delimiter scheme. A "directory" is a key prefix, and an empty directory
// is represented by a zero-byte "folder marker" object whose key ends in `/`.

import {
  FsError,
  sortEntries,
  type FileSystem,
  type FsEntry,
  type ReadHandle,
  type WriteHandle,
} from '../fs/FileSystem';
import { signRequest } from './sigv4';

export interface S3Config {
  /** Defaults to `https://s3.<region>.amazonaws.com`. */
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Use `https://<host>/<bucket>/<key>` instead of `https://<bucket>.<host>/<key>`. */
  forcePathStyle?: boolean;
}

const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

interface S3Response {
  status: number;
  ok: boolean;
  headers: Headers;
  text(): Promise<string>;
  body: ReadableStream<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Map an HTTP status (and optional S3 error code) into an FsError code. */
function statusToCode(status: number, s3Code?: string): FsError['code'] {
  if (status === 403) return 'permission';
  if (status === 404 || s3Code === 'NoSuchKey' || s3Code === 'NoSuchBucket') return 'not-found';
  return 'io';
}

/** Extract the `<Code>` element from an S3 error XML body, if present. */
function parseErrorCode(xml: string): string | undefined {
  const m = /<Code>([^<]*)<\/Code>/.exec(xml);
  return m ? m[1] : undefined;
}

/** Normalize a POSIX path to an S3 key prefix (no leading slash, trailing slash kept). */
function toKey(path: string): string {
  return path.replace(/^\/+/, '');
}

/** POSIX-normalize an S3 key back to an absolute path within the bucket. */
function toPath(key: string): string {
  return '/' + key.replace(/^\/+/, '');
}

/** A directory prefix always ends in exactly one `/` (root maps to ''). */
function dirPrefix(path: string): string {
  const key = toKey(path).replace(/\/+$/, '');
  return key === '' ? '' : key + '/';
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

/** Percent-encode a key for use in a request URL, preserving `/` separators. */
function encodeKey(key: string): string {
  return key
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

export class S3FS implements FileSystem {
  readonly kind = 's3' as const;
  readonly label: string;

  private readonly proto: string;
  private readonly host: string;

  constructor(
    private readonly cfg: S3Config,
    label?: string,
    // Injectable fetch for testing; defaults to the global.
    private readonly fetchImpl: typeof fetch = (...args: Parameters<typeof fetch>) =>
      globalThis.fetch(...args),
  ) {
    this.label = label ?? `s3://${cfg.bucket}`;
    const endpoint = cfg.endpoint ?? `https://s3.${cfg.region}.amazonaws.com`;
    const u = new URL(endpoint);
    this.proto = u.protocol; // includes trailing ':'
    this.host = u.host;
  }

  /** Build the request URL for a key (virtual-hosted by default, path-style if configured). */
  private urlFor(key: string, query?: Record<string, string>): string {
    const encoded = encodeKey(key);
    let base: string;
    if (this.cfg.forcePathStyle) {
      base = `${this.proto}//${this.host}/${this.cfg.bucket}/${encoded}`;
    } else {
      base = `${this.proto}//${this.cfg.bucket}.${this.host}/${encoded}`;
    }
    if (query && Object.keys(query).length > 0) {
      const qs = new URLSearchParams(query).toString();
      base += `?${qs}`;
    }
    return base;
  }

  /** Sign and send a single request. Never buffers the response body. */
  async request(
    method: string,
    key: string,
    opts: {
      query?: Record<string, string>;
      headers?: Record<string, string>;
      body?: Uint8Array;
      payloadHash?: string;
    } = {},
  ): Promise<S3Response> {
    const url = this.urlFor(key, opts.query);
    const signed = await signRequest({
      method,
      url,
      headers: opts.headers,
      body: opts.body,
      payloadHash: opts.payloadHash,
      region: this.cfg.region,
      service: 's3',
      accessKeyId: this.cfg.accessKeyId,
      secretAccessKey: this.cfg.secretAccessKey,
      sessionToken: this.cfg.sessionToken,
    });
    // `fetch` forbids setting `Host` manually; it derives it from the URL.
    delete signed['Host'];

    const res = await this.fetchImpl(url, {
      method,
      headers: signed,
      body: opts.body ? (opts.body as unknown as BodyInit) : undefined,
    });
    return res as unknown as S3Response;
  }

  /** Throw an FsError built from a non-OK response (consumes the body). */
  private async fail(res: S3Response, path: string): Promise<never> {
    let s3Code: string | undefined;
    try {
      s3Code = parseErrorCode(await res.text());
    } catch {
      // ignore body read errors
    }
    const code = statusToCode(res.status, s3Code);
    throw new FsError(code, `S3 ${res.status}${s3Code ? ` ${s3Code}` : ''}: ${path}`);
  }

  async list(path: string): Promise<FsEntry[]> {
    const prefix = dirPrefix(path);
    const entries: FsEntry[] = [];
    let continuationToken: string | undefined;

    do {
      const query: Record<string, string> = {
        'list-type': '2',
        delimiter: '/',
        prefix,
      };
      if (continuationToken) query['continuation-token'] = continuationToken;

      const res = await this.request('GET', '', { query });
      if (!res.ok) await this.fail(res, path);
      const xml = await res.text();
      const doc = new DOMParser().parseFromString(xml, 'application/xml');

      // CommonPrefixes -> subdirectories.
      for (const cp of Array.from(doc.getElementsByTagName('CommonPrefixes'))) {
        const p = cp.getElementsByTagName('Prefix')[0]?.textContent ?? '';
        const name = basename(p);
        if (!name) continue;
        entries.push({ name, path: toPath(p.replace(/\/+$/, '')), kind: 'dir' });
      }

      // Contents -> files (excluding the folder-marker object for this prefix).
      for (const c of Array.from(doc.getElementsByTagName('Contents'))) {
        const keyEl = c.getElementsByTagName('Key')[0]?.textContent ?? '';
        if (keyEl === prefix || keyEl === '') continue; // folder marker or empty
        const size = Number(c.getElementsByTagName('Size')[0]?.textContent ?? '0');
        const lm = c.getElementsByTagName('LastModified')[0]?.textContent ?? undefined;
        entries.push({
          name: basename(keyEl),
          path: toPath(keyEl),
          kind: 'file',
          size: Number.isFinite(size) ? size : undefined,
          mtime: lm ? Date.parse(lm) : undefined,
        });
      }

      const truncated =
        doc.getElementsByTagName('IsTruncated')[0]?.textContent?.trim() === 'true';
      continuationToken = truncated
        ? doc.getElementsByTagName('NextContinuationToken')[0]?.textContent ?? undefined
        : undefined;
    } while (continuationToken);

    return sortEntries(entries);
  }

  async stat(path: string): Promise<FsEntry> {
    const key = toKey(path);
    // Root is always a directory.
    if (key === '' || key === '/') {
      return { name: '', path: '/', kind: 'dir' };
    }

    // Try a HEAD on the object key (a file).
    const head = await this.request('HEAD', key);
    if (head.ok) {
      const len = head.headers.get('content-length');
      const lm = head.headers.get('last-modified');
      return {
        name: basename(path),
        path: toPath(key),
        kind: 'file',
        size: len ? Number(len) : undefined,
        mtime: lm ? Date.parse(lm) : undefined,
      };
    }
    if (head.status !== 404) await this.fail(head, path);

    // Not a file: is it a directory prefix (has any children, or a folder marker)?
    const prefix = dirPrefix(path);
    const res = await this.request('GET', '', {
      query: { 'list-type': '2', prefix, 'max-keys': '1' },
    });
    if (!res.ok) await this.fail(res, path);
    const xml = await res.text();
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const count = doc.getElementsByTagName('Contents').length;
    if (count > 0) {
      return { name: basename(path), path: toPath(prefix.replace(/\/+$/, '')), kind: 'dir' };
    }
    throw new FsError('not-found', `Not found: ${path}`);
  }

  async mkdir(path: string): Promise<void> {
    const prefix = dirPrefix(path);
    if (prefix === '') throw new FsError('exists', 'Cannot create the bucket root');
    // Fail if a marker or any keys already exist under this prefix.
    const existing = await this.request('GET', '', {
      query: { 'list-type': '2', prefix, 'max-keys': '1' },
    });
    if (existing.ok) {
      const xml = await existing.text();
      const doc = new DOMParser().parseFromString(xml, 'application/xml');
      if (doc.getElementsByTagName('Contents').length > 0) {
        throw new FsError('exists', `Already exists: ${path}`);
      }
    } else if (existing.status !== 404) {
      await this.fail(existing, path);
    }
    // Write the zero-byte folder marker at `<prefix>` (key ends in `/`).
    const res = await this.request('PUT', prefix, {
      body: new Uint8Array(0),
      headers: { 'content-length': '0' },
    });
    if (!res.ok) await this.fail(res, path);
  }

  async rename(from: string, to: string): Promise<void> {
    return this.move(from, to);
  }

  async move(from: string, to: string): Promise<void> {
    // S3 has no move; copy every key under the source then delete the source.
    const fromKey = toKey(from);
    const isDir = await this.isPrefix(from);
    if (isDir) {
      const fromPrefix = dirPrefix(from);
      const toPrefix = dirPrefix(to);
      const keys = await this.listAllKeys(fromPrefix);
      for (const key of keys) {
        const dest = toPrefix + key.slice(fromPrefix.length);
        await this.copyKey(key, dest);
      }
      // Also move the marker object itself if it exists as a bare prefix key.
      for (const key of keys) {
        await this.deleteKey(key);
      }
    } else {
      await this.copyKey(fromKey, toKey(to));
      await this.deleteKey(fromKey);
    }
  }

  private async copyKey(fromKey: string, toKey: string): Promise<void> {
    // x-amz-copy-source must be `/<bucket>/<url-encoded-key>`.
    const source = `/${this.cfg.bucket}/${encodeKey(fromKey)}`;
    const res = await this.request('PUT', toKey, {
      headers: { 'x-amz-copy-source': source },
    });
    if (!res.ok) await this.fail(res, fromKey);
  }

  private async deleteKey(key: string): Promise<void> {
    const res = await this.request('DELETE', key);
    // S3 DELETE returns 204 even when the key is absent; treat 404 as success.
    if (!res.ok && res.status !== 404) await this.fail(res, key);
  }

  /** Does any object exist under this path's directory prefix? */
  private async isPrefix(path: string): Promise<boolean> {
    const prefix = dirPrefix(path);
    if (prefix === '') return true;
    const res = await this.request('GET', '', {
      query: { 'list-type': '2', prefix, 'max-keys': '1' },
    });
    if (!res.ok) {
      if (res.status === 404) return false;
      await this.fail(res, path);
    }
    const xml = await res.text();
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    return doc.getElementsByTagName('Contents').length > 0;
  }

  /** All object keys under a prefix (no delimiter), following pagination. */
  private async listAllKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const query: Record<string, string> = { 'list-type': '2', prefix };
      if (continuationToken) query['continuation-token'] = continuationToken;
      const res = await this.request('GET', '', { query });
      if (!res.ok) await this.fail(res, toPath(prefix));
      const xml = await res.text();
      const doc = new DOMParser().parseFromString(xml, 'application/xml');
      for (const c of Array.from(doc.getElementsByTagName('Contents'))) {
        const k = c.getElementsByTagName('Key')[0]?.textContent ?? '';
        if (k) keys.push(k);
      }
      const truncated =
        doc.getElementsByTagName('IsTruncated')[0]?.textContent?.trim() === 'true';
      continuationToken = truncated
        ? doc.getElementsByTagName('NextContinuationToken')[0]?.textContent ?? undefined
        : undefined;
    } while (continuationToken);
    return keys;
  }

  async remove(path: string, recursive: boolean): Promise<void> {
    const key = toKey(path);
    // A HEAD tells us whether this is a concrete file.
    const head = await this.request('HEAD', key);
    if (head.ok) {
      await this.deleteKey(key);
      return;
    }
    if (head.status !== 404) await this.fail(head, path);

    // Directory: enumerate everything under the prefix.
    const prefix = dirPrefix(path);
    const keys = await this.listAllKeys(prefix);
    if (keys.length === 0) {
      throw new FsError('not-found', `Not found: ${path}`);
    }
    // Non-empty means more than just the folder marker.
    const nonMarker = keys.filter((k) => k !== prefix);
    if (nonMarker.length > 0 && !recursive) {
      throw new FsError('not-empty', `Directory not empty: ${path}`);
    }
    for (const k of keys) {
      await this.deleteKey(k);
    }
  }

  async openRead(
    path: string,
    offset = 0,
    _opts?: { pipelineDepth?: number },
  ): Promise<ReadHandle> {
    const key = toKey(path);
    const headers: Record<string, string> = {};
    if (offset > 0) headers['Range'] = `bytes=${offset}-`;

    const res = await this.request('GET', key, { headers });
    if (!res.ok) await this.fail(res, path);

    // Determine total size from Content-Range (when ranged) or Content-Length.
    let size: number | undefined;
    const contentRange = res.headers.get('content-range');
    if (contentRange) {
      const m = /\/(\d+)\s*$/.exec(contentRange);
      if (m) size = Number(m[1]);
    } else {
      const len = res.headers.get('content-length');
      if (len) size = Number(len) + offset;
    }

    const reader = res.body?.getReader();
    let leftover: Uint8Array | null = null;
    let done = false;

    return {
      size,
      async read(into: Uint8Array): Promise<number> {
        if (!reader) return 0;
        // Drain any bytes left over from a chunk larger than `into`.
        if (leftover && leftover.length > 0) {
          const n = Math.min(leftover.length, into.byteLength);
          into.set(leftover.subarray(0, n));
          leftover = n < leftover.length ? leftover.subarray(n) : null;
          return n;
        }
        if (done) return 0;
        const { value, done: rdone } = await reader.read();
        if (rdone || !value || value.length === 0) {
          done = true;
          return 0;
        }
        const n = Math.min(value.length, into.byteLength);
        into.set(value.subarray(0, n));
        if (n < value.length) leftover = value.subarray(n);
        return n;
      },
      async close(): Promise<void> {
        try {
          await reader?.cancel();
        } catch {
          // best-effort
        }
      },
    };
  }

  async openWrite(
    path: string,
    _size?: number,
    _opts?: { resume?: boolean; pipelineDepth?: number },
  ): Promise<WriteHandle> {
    // Simplest correct approach: buffer all chunks in memory and PUT the whole
    // object once on close(). No multipart / streaming upload yet, so very large
    // files are held entirely in memory. `startOffset` is always 0 (no resume).
    const key = toKey(path);
    const chunks: Uint8Array[] = [];
    let aborted = false;
    const self = this;

    return {
      startOffset: 0,
      async write(chunk: Uint8Array): Promise<void> {
        if (aborted) return;
        // Copy: the caller may reuse its buffer after write() returns.
        chunks.push(chunk.slice());
      },
      async close(): Promise<void> {
        if (aborted) return;
        let total = 0;
        for (const c of chunks) total += c.length;
        const body = new Uint8Array(total);
        let pos = 0;
        for (const c of chunks) {
          body.set(c, pos);
          pos += c.length;
        }
        const res = await self.request('PUT', key, {
          body,
          headers: { 'content-length': String(total) },
          payloadHash: UNSIGNED_PAYLOAD,
        });
        if (!res.ok) await self.fail(res, path);
      },
      async abort(): Promise<void> {
        aborted = true;
        chunks.length = 0;
      },
    };
  }
}
