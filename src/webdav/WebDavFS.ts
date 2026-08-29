import {
  FsError,
  sortEntries,
  type FileSystem,
  type FsEntry,
  type FsErrorCode,
  type ReadHandle,
  type WriteHandle,
} from '../fs/FileSystem';
import { base64Encode } from '../net/base64';

const DAV_NS = 'DAV:';

/** Body sent with every PROPFIND: request just the props we map to FsEntry. */
const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<D:propfind xmlns:D="DAV:"><D:prop>' +
  '<D:resourcetype/><D:getcontentlength/><D:getlastmodified/>' +
  '</D:prop></D:propfind>';

/** Build the value for an `Authorization: Basic` header from credentials. */
export function buildBasicAuth(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  return `Basic ${base64Encode(bytes)}`;
}

/** Map an HTTP status onto the uniform FsError code taxonomy. */
function codeForStatus(status: number): FsErrorCode {
  if (status === 401 || status === 403) return 'permission';
  if (status === 404) return 'not-found';
  return 'io';
}

function fsErrorForStatus(status: number, message: string): FsError {
  return new FsError(codeForStatus(status), message);
}

/** Strip trailing slashes from a POSIX path, keeping root as "/". */
function stripTrailingSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/** Percent-encode each path segment while preserving "/" separators. */
function encodePath(p: string): string {
  return p
    .split('/')
    .map((seg) => (seg === '' ? '' : encodeURIComponent(seg)))
    .join('/');
}

/** Decode each segment of a percent-encoded path back to a POSIX path. */
function decodePath(p: string): string {
  return p
    .split('/')
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .join('/');
}

function basename(path: string): string {
  const norm = stripTrailingSlash(path);
  const i = norm.lastIndexOf('/');
  return i < 0 ? norm : norm.slice(i + 1) || '/';
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

function firstChildNS(parent: Element, tag: string): Element | null {
  const els = parent.getElementsByTagNameNS(DAV_NS, tag);
  return els.length ? els[0] : null;
}

/** Parsed view of one `<D:response>` element from a multistatus document. */
interface DavResponse {
  path: string; // decoded POSIX path, trailing slash stripped
  entry: FsEntry;
}

export class WebDavParseError extends Error {}

/**
 * WebDAV (RFC 4918) file system over the global `fetch`, addressing resources by
 * POSIX path. Paths handled here are server-absolute (they include whatever
 * mount prefix the base URL carried); requests are built as `origin + path`.
 */
export class WebDavFS implements FileSystem {
  readonly kind = 'webdav' as const;
  private readonly origin: string;

  /**
   * @param baseUrl   e.g. `https://host/dav/` — supplies the request origin.
   * @param authHeader value for the `Authorization` header (e.g. from
   *                   {@link buildBasicAuth}). Sent with every request.
   */
  constructor(
    baseUrl: string,
    private readonly authHeader: string,
    readonly label = 'WebDAV',
  ) {
    this.origin = new URL(baseUrl).origin;
  }

  private urlFor(path: string): string {
    return this.origin + encodePath(path);
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { Authorization: this.authHeader, ...extra };
  }

  /** Run a request, mapping network failures to FsError('io'). */
  private async request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, init);
    } catch (e) {
      throw new FsError('io', e instanceof Error ? e.message : String(e), e);
    }
  }

  /** Parse a 207 multistatus body into per-response entries. */
  private parseMultistatus(xml: string): DavResponse[] {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) {
      throw new WebDavParseError('Malformed multistatus XML');
    }
    const responses = doc.getElementsByTagNameNS(DAV_NS, 'response');
    const out: DavResponse[] = [];
    for (let i = 0; i < responses.length; i++) {
      const res = responses[i];
      const hrefEl = firstChildNS(res, 'href');
      if (!hrefEl || !hrefEl.textContent) continue;
      const pathname = new URL(hrefEl.textContent, this.origin).pathname;
      const path = stripTrailingSlash(decodePath(pathname));

      const resourceType = firstChildNS(res, 'resourcetype');
      const isDir = !!(resourceType && firstChildNS(resourceType, 'collection'));

      const lenEl = firstChildNS(res, 'getcontentlength');
      const size =
        lenEl && lenEl.textContent && lenEl.textContent.trim() !== ''
          ? Number(lenEl.textContent.trim())
          : undefined;

      const modEl = firstChildNS(res, 'getlastmodified');
      const parsed = modEl && modEl.textContent ? Date.parse(modEl.textContent) : NaN;
      const mtime = Number.isNaN(parsed) ? undefined : parsed;

      out.push({
        path,
        entry: {
          name: basename(path),
          path,
          kind: isDir ? 'dir' : 'file',
          size: isDir ? undefined : size,
          mtime,
          raw: hrefEl.textContent,
        },
      });
    }
    return out;
  }

  private async propfind(path: string, depth: '0' | '1'): Promise<DavResponse[]> {
    const res = await this.request(this.urlFor(path), {
      method: 'PROPFIND',
      headers: this.headers({ Depth: depth, 'Content-Type': 'application/xml' }),
      body: PROPFIND_BODY,
    });
    if (res.status === 404) throw new FsError('not-found', `No such path: ${path}`);
    if (res.status !== 207) {
      throw fsErrorForStatus(res.status, `PROPFIND ${path} failed: ${res.status}`);
    }
    return this.parseMultistatus(await res.text());
  }

  async list(path: string): Promise<FsEntry[]> {
    const self = stripTrailingSlash(path);
    const responses = await this.propfind(path, '1');
    const children = responses.filter((r) => r.path !== self).map((r) => r.entry);
    return sortEntries(children);
  }

  async stat(path: string): Promise<FsEntry> {
    const responses = await this.propfind(path, '0');
    const self = stripTrailingSlash(path);
    const match = responses.find((r) => r.path === self) ?? responses[0];
    if (!match) throw new FsError('not-found', `No such path: ${path}`);
    return match.entry;
  }

  async mkdir(path: string): Promise<void> {
    const res = await this.request(this.urlFor(path), {
      method: 'MKCOL',
      headers: this.headers(),
    });
    if (res.status === 201) return;
    if (res.status === 405 || res.status === 409) {
      // Ambiguous: either the target already exists, or the parent is missing.
      // Probe to distinguish.
      let existing: FsEntry | undefined;
      try {
        existing = await this.stat(path);
      } catch {
        existing = undefined;
      }
      if (existing) throw new FsError('exists', `Already exists: ${path}`);
      throw new FsError('io', `MKCOL ${path} failed: ${res.status}`);
    }
    throw fsErrorForStatus(res.status, `MKCOL ${path} failed: ${res.status}`);
  }

  async remove(path: string, recursive: boolean): Promise<void> {
    if (!recursive) {
      // WebDAV DELETE on a collection is always recursive, so guard non-empty
      // dirs ourselves: a Depth:1 PROPFIND lists the resource plus its children.
      const self = stripTrailingSlash(path);
      const responses = await this.propfind(path, '1');
      const hasChildren = responses.some((r) => r.path !== self);
      if (hasChildren) throw new FsError('not-empty', `Directory not empty: ${path}`);
    }
    const res = await this.request(this.urlFor(path), {
      method: 'DELETE',
      headers: this.headers(),
    });
    // 204 No Content / 200 OK are both success.
    if (res.status === 204 || res.status === 200) return;
    if (res.status === 404) throw new FsError('not-found', `No such path: ${path}`);
    throw fsErrorForStatus(res.status, `DELETE ${path} failed: ${res.status}`);
  }

  async rename(from: string, to: string): Promise<void> {
    const res = await this.request(this.urlFor(from), {
      method: 'MOVE',
      headers: this.headers({ Destination: this.urlFor(to), Overwrite: 'T' }),
    });
    // 201 Created / 204 No Content are both success.
    if (res.status === 201 || res.status === 204) return;
    if (res.status === 404) throw new FsError('not-found', `No such path: ${from}`);
    throw fsErrorForStatus(res.status, `MOVE ${from} -> ${to} failed: ${res.status}`);
  }

  async move(from: string, to: string): Promise<void> {
    return this.rename(from, to);
  }

  async openRead(path: string, offset = 0): Promise<ReadHandle> {
    const range = offset > 0 ? { Range: `bytes=${offset}-` } : undefined;
    const res = await this.request(this.urlFor(path), {
      method: 'GET',
      headers: this.headers(range),
    });
    if (res.status === 404) throw new FsError('not-found', `No such path: ${path}`);
    if (res.status !== 200 && res.status !== 206) {
      throw fsErrorForStatus(res.status, `GET ${path} failed: ${res.status}`);
    }

    // Resolve the total size from Content-Range (`bytes 0-99/12345`) or
    // Content-Length. Undefined if the server reports neither.
    let size: number | undefined;
    const contentRange = res.headers.get('Content-Range');
    if (contentRange) {
      const m = /\/(\d+)\s*$/.exec(contentRange);
      if (m) size = Number(m[1]);
    } else {
      const len = res.headers.get('Content-Length');
      if (len !== null && len !== '') {
        const n = Number(len);
        size = Number.isNaN(n) ? undefined : n + offset;
      }
    }

    // Some servers ignore Range and reply 200 with the whole body; discard the
    // first `offset` bytes so callers still resume correctly.
    let toSkip = offset > 0 && res.status === 200 ? offset : 0;

    const reader = res.body ? res.body.getReader() : null;
    let leftover: Uint8Array | null = null;
    let done = reader === null;

    async function pull(): Promise<Uint8Array | null> {
      if (leftover) {
        const b = leftover;
        leftover = null;
        return b;
      }
      if (done || !reader) return null;
      for (;;) {
        const { value, done: d } = await reader.read();
        if (d) {
          done = true;
          return null;
        }
        let chunk = value as Uint8Array;
        if (toSkip > 0) {
          if (chunk.byteLength <= toSkip) {
            toSkip -= chunk.byteLength;
            continue; // whole chunk skipped
          }
          chunk = chunk.subarray(toSkip);
          toSkip = 0;
        }
        if (chunk.byteLength === 0) continue;
        return chunk;
      }
    }

    return {
      size,
      async read(into: Uint8Array): Promise<number> {
        const chunk = await pull();
        if (!chunk) return 0; // EOF
        const n = Math.min(into.byteLength, chunk.byteLength);
        into.set(chunk.subarray(0, n));
        if (n < chunk.byteLength) leftover = chunk.subarray(n);
        return n;
      },
      async close() {
        if (reader && !done) {
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
        }
      },
    };
  }

  async openWrite(path: string): Promise<WriteHandle> {
    // WebDAV has no standard chunked/resumable upload primitive, so the whole
    // file is buffered in memory and committed with a single PUT on close().
    // This means very large uploads are bounded by available memory, and resume
    // is unsupported (startOffset is always 0).
    const parts: Uint8Array[] = [];
    let aborted = false;
    const self = this;
    return {
      startOffset: 0,
      async write(chunk: Uint8Array) {
        parts.push(chunk.slice());
      },
      async close() {
        if (aborted) return;
        const body = concat(parts);
        const res = await self.request(self.urlFor(path), {
          method: 'PUT',
          headers: self.headers({ 'Content-Type': 'application/octet-stream' }),
          // A Uint8Array is a valid fetch BodyInit at runtime; the cast placates
          // the ArrayBuffer/ArrayBufferLike strictness in the DOM typings.
          body: body as unknown as BodyInit,
        });
        if (res.status === 200 || res.status === 201 || res.status === 204) return;
        throw fsErrorForStatus(res.status, `PUT ${path} failed: ${res.status}`);
      },
      async abort() {
        aborted = true;
        parts.length = 0; // discard the buffer; no request is issued
      },
    };
  }
}
