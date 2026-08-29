// AWS Signature Version 4 signing over the global `fetch`, implemented with
// WebCrypto (`crypto.subtle`). Pure and dependency-free so it can be unit-tested
// against the official AWS SigV4 test vectors with an injected clock.
//
// Reference: "Signing AWS requests with Signature Version 4"
// https://docs.aws.amazon.com/general/latest/gr/sigv4-create-canonical-request.html

const encoder = new TextEncoder();

/** Lowercase hex of a byte array. */
function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', data as unknown as BufferSource);
  return new Uint8Array(digest);
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  return toHex(await sha256(data));
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as unknown as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, data as unknown as BufferSource);
  return new Uint8Array(sig);
}

/**
 * RFC 3986 percent-encoding as AWS expects it: unreserved characters
 * (A-Z a-z 0-9 - _ . ~) pass through, everything else is percent-encoded.
 * `encodeURIComponent` leaves `!*'()` alone, so encode those explicitly.
 */
export function encodeRfc3986(str: string): string {
  return encodeURIComponent(str).replace(
    /[!*'()]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/**
 * Canonical URI: percent-encode each path segment (single-encoding for the
 * `s3` service) while preserving the `/` separators. Segments are decoded first
 * so an already-encoded path (as produced by `new URL()`) is normalized rather
 * than double-encoded.
 */
function canonicalUri(pathname: string): string {
  if (pathname === '' || pathname === '/') return '/';
  return pathname
    .split('/')
    .map((seg) => {
      let decoded = seg;
      try {
        decoded = decodeURIComponent(seg);
      } catch {
        // leave as-is if it isn't valid percent-encoding
      }
      return encodeRfc3986(decoded);
    })
    .join('/');
}

/** Canonical query string: entries sorted by encoded key (then value), joined `k=v&...`. */
function canonicalQuery(searchParams: URLSearchParams): string {
  const pairs: Array<[string, string]> = [];
  for (const [k, v] of searchParams) {
    pairs.push([encodeRfc3986(k), encodeRfc3986(v)]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

/** amzDate `YYYYMMDDTHHMMSSZ` and dateStamp `YYYYMMDD` from a Date. */
function formatDates(date: Date): { amzDate: string; dateStamp: string } {
  const iso = date.toISOString(); // e.g. 2013-05-24T00:00:00.000Z
  const amzDate = iso.replace(/[:-]|\.\d{3}/g, '').replace(/(\d{8}T\d{6})Z/, '$1Z');
  // The line above turns 2013-05-24T00:00:00.000Z -> 20130524T000000Z
  const dateStamp = amzDate.slice(0, 8);
  return { amzDate, dateStamp };
}

async function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<Uint8Array> {
  const kDate = await hmac(encoder.encode('AWS4' + secretAccessKey), encoder.encode(dateStamp));
  const kRegion = await hmac(kDate, encoder.encode(region));
  const kService = await hmac(kRegion, encoder.encode(service));
  return hmac(kService, encoder.encode('aws4_request'));
}

export interface SignRequestParams {
  method: string;
  /** Full request URL (host, path and query). */
  url: string;
  /** Extra headers to sign/send. `host`, `x-amz-date` and `x-amz-content-sha256` are added automatically. */
  headers?: Record<string, string>;
  /** Request body used to compute the payload hash when no hash is supplied. */
  body?: Uint8Array;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /**
   * Pre-computed payload hash (hex sha256) or the literal `UNSIGNED-PAYLOAD`.
   * Overrides hashing `body`. If a caller passes `x-amz-content-sha256` in
   * `headers`, that wins over everything.
   */
  payloadHash?: string;
  /** Injectable clock for deterministic tests. Defaults to `new Date()`. */
  dateOverride?: Date;
}

/**
 * Sign a request with AWS SigV4 and return the complete set of headers to send.
 * The returned object includes `Host` (which `fetch` sets itself and forbids as
 * a manual header) — callers over `fetch` should drop it before sending.
 */
export async function signRequest(params: SignRequestParams): Promise<Record<string, string>> {
  const {
    method,
    url,
    body,
    region,
    service,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    payloadHash,
    dateOverride,
  } = params;

  const u = new URL(url);
  const { amzDate, dateStamp } = formatDates(dateOverride ?? new Date());

  // Assemble the header set to sign. Lowercase names; a case-insensitive lookup
  // lets a caller-supplied `x-amz-content-sha256` take precedence.
  const rawHeaders = params.headers ?? {};
  const lower: Record<string, string> = {};
  for (const [name, value] of Object.entries(rawHeaders)) {
    lower[name.toLowerCase()] = String(value);
  }

  // Payload hash: explicit header > explicit param > hash of body > empty hash.
  let contentSha = lower['x-amz-content-sha256'];
  if (contentSha === undefined) {
    contentSha = payloadHash ?? (await sha256Hex(body ?? new Uint8Array(0)));
  }

  lower['host'] = u.host;
  lower['x-amz-date'] = amzDate;
  lower['x-amz-content-sha256'] = contentSha;
  if (sessionToken) lower['x-amz-security-token'] = sessionToken;

  // Canonical + signed headers (sorted, trimmed, inner whitespace collapsed).
  const sortedNames = Object.keys(lower).sort();
  const canonicalHeaders = sortedNames
    .map((n) => `${n}:${lower[n].trim().replace(/\s+/g, ' ')}\n`)
    .join('');
  const signedHeaders = sortedNames.join(';');

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri(u.pathname),
    canonicalQuery(u.searchParams),
    canonicalHeaders,
    signedHeaders,
    contentSha,
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    await sha256Hex(encoder.encode(canonicalRequest)),
  ].join('\n');

  const signingKey = await deriveSigningKey(secretAccessKey, dateStamp, region, service);
  const signature = toHex(await hmac(signingKey, encoder.encode(stringToSign)));

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  // Return the original-cased caller headers plus the signing headers.
  const out: Record<string, string> = { ...rawHeaders };
  out['Host'] = u.host;
  out['x-amz-date'] = amzDate;
  out['x-amz-content-sha256'] = contentSha;
  if (sessionToken) out['x-amz-security-token'] = sessionToken;
  out['Authorization'] = authorization;
  return out;
}
