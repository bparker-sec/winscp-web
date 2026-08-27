# WinSCP Web — Plan 2: OneDrive Local Side Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task with a spec reviewer + code-quality reviewer per major step. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the local pane's MockFS with a real **OneDrive** file system, reached through Microsoft Graph using an OAuth token brokered by the host via `ai-publish-sdk`, and add the sign-in / connect-disconnect flow. The remote pane stays MockFS until Plan 4 (SFTP).

**Architecture:** A crash-safe SDK wrapper layer (`sdk/client.ts`) brokers host RPC. A race-safe session coordinator (`onedrive/session.ts` + `auth.ts`) owns the OneDrive token. A path-addressed Graph client (`onedrive/graph.ts`) performs REST calls. `OneDriveFS` implements the existing `FileSystem` interface on top, mapping Graph results to `FsEntry` and Graph errors to `FsError`. `AppProvider` gains OneDrive session state and swaps the local pane between a sign-in prompt and a live `OneDriveFS`.

**Tech Stack:** ai-publish-sdk, Microsoft Graph v1.0 REST, React 18, TypeScript, Vitest.

**Depends on:** Plan 1 (FileSystem interface, MockFS, shell, AppProvider). Nothing here changes the `FileSystem` contract; it only adds an implementation and session/UI wiring.

---

## Key design decisions

- **Path addressing, not id caching.** Graph supports `/me/drive/root:/{path}` addressing, so `OneDriveFS` maps its POSIX paths directly to Graph URLs — no id cache to keep coherent.
- **Session coordinator reused verbatim** from the proven notepad++ implementation (fully unit-tested against races: clear-during-connect, stale-silent-vs-fresh-interactive, serialized clears, durable recovery flag).
- **Streaming I/O.** `openRead` pulls byte ranges lazily (`Range` GETs); `openWrite` with a known `size` streams to a resumable upload session in 320 KiB-aligned chunks; unknown-size writes buffer then upload on close. No whole-file buffering on the streaming path.
- **Graceful host absence.** When no host answers RPC (e.g. app opened outside the Island host during review), the UI shows a sign-in / "host unavailable" state instead of crashing.
- **Graph error → FsError mapping:** 404→`not-found`, 409→`exists`, 403→`permission`, 507→`io`, else→`io`.

## File Structure

- `src/sdk/client.ts` (+ `client.test.ts`) — crash-safe ai-publish-sdk wrappers
- `src/onedrive/session.ts` (+ `session.test.ts`) — race-safe session coordinator
- `src/onedrive/auth.ts` — session singleton + `Authable` adapter + connect/clear helpers
- `src/onedrive/graph.ts` (+ `graph.test.ts`) — path-addressed Graph client + `DriveItem`→`FsEntry`
- `src/onedrive/OneDriveFS.ts` (+ `OneDriveFS.test.ts`) — `FileSystem` implementation
- `src/state/AppProvider.tsx` (modify) — OneDrive session state; local pane = OneDriveFS | sign-in
- `src/ui/AccountButton.tsx` — sign-in / account / disconnect control in the MenuBar
- `src/ui/ConnectHint.tsx` — the "sign in to OneDrive" pane placeholder
- `src/ui/MenuBar.tsx` (modify) — host the AccountButton

---

## Task 2A: SDK wrapper layer

**Files:** Create `src/sdk/client.ts`, `src/sdk/client.test.ts`

- [ ] **Step 1: Write `src/sdk/client.ts`**

```ts
// Crash-safe wrappers around ai-publish-sdk. Every host interaction goes through
// here; each wrapper degrades to a safe fallback if the SDK/host is unavailable
// (e.g. when the built app is opened outside a host during review).
import {
  getUserInfo,
  getToken,
  clearToken,
  getBrandingAssets,
  trackEvent,
  withTimeout,
  type UserInfo,
  type BrandingAssets,
  type TrackEventDetails,
  type TrackEventParams,
} from 'ai-publish-sdk';

export type { UserInfo, BrandingAssets };

const ONEDRIVE = 'onedrive';
const INTERACTIVE_TIMEOUT_MS = 120_000;
const HOST_PROBE_TIMEOUT_MS = 4_000;
const SILENT_TIMEOUT_MS = 8_000; // bound host-absent stalls (SDK default is 15s)

/** True when a host is actually answering RPC (probed, not inferred from frames). */
export async function sdkProbeHost(): Promise<boolean> {
  try {
    await withTimeout(() => getUserInfo(), HOST_PROBE_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
}

export async function sdkGetUser(): Promise<UserInfo | null> {
  try {
    return await withTimeout(() => getUserInfo(), HOST_PROBE_TIMEOUT_MS);
  } catch {
    return null;
  }
}

export type OneDriveTokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'no_token' | 'timeout' | 'error'; detail?: string };

/** Acquire a OneDrive OAuth token via the host, reporting WHY it failed. */
export async function sdkGetOneDriveTokenResult(
  interactive: boolean,
): Promise<OneDriveTokenResult> {
  try {
    const call = () => getToken(ONEDRIVE, { interactive });
    const res = interactive
      ? await withTimeout(call, INTERACTIVE_TIMEOUT_MS)
      : await withTimeout(call, SILENT_TIMEOUT_MS);
    if (res?.token) return { ok: true, token: res.token };
    return { ok: false, reason: 'no_token' };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: /timeout/i.test(detail) ? 'timeout' : 'error', detail };
  }
}

/** Clear the host-managed OneDrive session. Returns true only on confirmed clear. */
export async function sdkClearOneDriveResult(): Promise<boolean> {
  try {
    await withTimeout(() => clearToken(ONEDRIVE), SILENT_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
}

export async function sdkGetBranding(): Promise<BrandingAssets | null> {
  try {
    return await withTimeout(() => getBrandingAssets(), HOST_PROBE_TIMEOUT_MS);
  } catch {
    return null;
  }
}

/** Fire-and-forget analytics. Never throws (or rejects) into the UI. */
export function sdkTrack(eventName: string, additionalDetails?: TrackEventDetails): void {
  try {
    const params = { eventName, additionalDetails } as unknown as TrackEventParams;
    Promise.resolve(trackEvent(params)).catch(() => {});
  } catch {
    /* ignore */
  }
}
```

- [ ] **Step 2: Write `src/sdk/client.test.ts`** (mock the SDK; verify integration name + no-throw)

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('ai-publish-sdk');
});

function mockSdk(over: Record<string, unknown>) {
  vi.doMock('ai-publish-sdk', () => ({
    getUserInfo: vi.fn(),
    getToken: vi.fn(),
    clearToken: vi.fn(),
    getBrandingAssets: vi.fn(),
    trackEvent: vi.fn(),
    withTimeout: (fn: () => Promise<unknown>) => fn(),
    ...over,
  }));
}

describe('sdk client', () => {
  it("getToken uses the 'onedrive' integration and returns the token", async () => {
    const getToken = vi.fn().mockResolvedValue({ token: 'T' });
    mockSdk({ getToken });
    const { sdkGetOneDriveTokenResult } = await import('./client');
    const res = await sdkGetOneDriveTokenResult(true);
    expect(res).toEqual({ ok: true, token: 'T' });
    expect(getToken).toHaveBeenCalledWith('onedrive', { interactive: true });
  });

  it('reports no_token when the host returns nothing', async () => {
    mockSdk({ getToken: vi.fn().mockResolvedValue(null) });
    const { sdkGetOneDriveTokenResult } = await import('./client');
    expect(await sdkGetOneDriveTokenResult(false)).toEqual({ ok: false, reason: 'no_token' });
  });

  it('maps a thrown error and never throws', async () => {
    mockSdk({ getToken: vi.fn().mockRejectedValue(new Error('boom')) });
    const { sdkGetOneDriveTokenResult } = await import('./client');
    const res = await sdkGetOneDriveTokenResult(true);
    expect(res.ok).toBe(false);
  });

  it("sdkClearOneDriveResult calls clearToken('onedrive') and returns true", async () => {
    const clearToken = vi.fn().mockResolvedValue(undefined);
    mockSdk({ clearToken });
    const { sdkClearOneDriveResult } = await import('./client');
    await expect(sdkClearOneDriveResult()).resolves.toBe(true);
    expect(clearToken).toHaveBeenCalledWith('onedrive');
  });

  it('sdkClearOneDriveResult returns false when the host clear fails', async () => {
    mockSdk({ clearToken: vi.fn().mockRejectedValue(new Error('x')) });
    const { sdkClearOneDriveResult } = await import('./client');
    await expect(sdkClearOneDriveResult()).resolves.toBe(false);
  });

  it('sdkProbeHost is false when getUserInfo throws', async () => {
    mockSdk({ getUserInfo: vi.fn().mockRejectedValue(new Error('no host')) });
    const { sdkProbeHost } = await import('./client');
    expect(await sdkProbeHost()).toBe(false);
  });
});
```

- [ ] **Step 3:** Run `npx vitest run src/sdk/client.test.ts` — expect all pass.
- [ ] **Step 4:** Commit: `git add src/sdk && git commit -m "feat: crash-safe ai-publish-sdk wrappers"`

---

## Task 2B: OneDrive session coordinator (reused, race-tested)

**Files:** Create `src/onedrive/session.ts`, `src/onedrive/session.test.ts`, `src/onedrive/auth.ts`

- [ ] **Step 1: Write `src/onedrive/session.ts`** — copy VERBATIM from the notepad++ reference at `C:\Users\ben\Documents\Claude\Projects\notepad++\src\onedrive\session.ts` (the coordinator class `OneDriveSession` with `SessionProvider`, `RecoveryStore`, `SessionState`, `AcquireOutcome`). It imports only `type OneDriveTokenResult` from `../sdk/client`. Do not modify its logic.

- [ ] **Step 2: Write `src/onedrive/session.test.ts`** — copy VERBATIM from `C:\Users\ben\Documents\Claude\Projects\notepad++\src\onedrive\session.test.ts`, EXCEPT remove the final `describe('sdkClearOneDriveResult ...')` block (that behavior is already covered by `src/sdk/client.test.ts` in Task 2A). Keep all `OneDriveSession` clearing/races/reload-recovery tests.

- [ ] **Step 3: Write `src/onedrive/auth.ts`** — copy VERBATIM from `C:\Users\ben\Documents\Claude\Projects\notepad++\src\onedrive\auth.ts`. It wires the coordinator to the SDK provider (`sdkGetOneDriveTokenResult`/`sdkClearOneDriveResult`), exposes `oneDriveAuth: Authable`, `trySilentOneDrive`, `connectOneDrive`, `clearOneDriveSession`, `oneDriveState`, `isOneDriveSignedIn`, etc. Its `Authable` import must come from `./graph` (created in Task 2C).

- [ ] **Step 4:** Run `npx vitest run src/onedrive/session.test.ts` — expect all pass. (auth.ts has no direct test; it is exercised via OneDriveFS + app.)
- [ ] **Step 5:** Commit: `git add src/onedrive/session.ts src/onedrive/session.test.ts src/onedrive/auth.ts && git commit -m "feat: race-safe OneDrive session coordinator and auth adapter"`

---

## Task 2C: Path-addressed Graph client

**Files:** Create `src/onedrive/graph.ts`, `src/onedrive/graph.test.ts`

- [ ] **Step 1: Write `src/onedrive/graph.ts`**

```ts
// Microsoft Graph client for OneDrive, called directly from the browser with a
// Bearer token brokered by the host via ai-publish-sdk. No server involved.
// Addresses items by POSIX path (/me/drive/root:/{path}) to match FileSystem.
import { type FsEntry } from '../fs/FileSystem';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const SELECT = 'id,name,size,folder,file,parentReference,lastModifiedDateTime';

export interface DriveItem {
  id: string;
  name: string;
  size?: number;
  folder?: { childCount?: number };
  file?: { mimeType?: string };
  parentReference?: { id?: string; path?: string };
  lastModifiedDateTime?: string;
}

/** Provides (and can force-refresh) a OneDrive access token. */
export interface Authable {
  getToken(force?: boolean): Promise<string | null>;
}

export class GraphError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GraphError';
  }
}

// ---- Pure URL / path builders (unit-tested) --------------------------------

/** Encode each path segment but keep the slashes; drop any leading slash. */
export function encodePath(path: string): string {
  return path
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean)
    .map((s) => encodeURIComponent(s))
    .join('/');
}

const isRoot = (path: string) => encodePath(path) === '';

export function childrenUrl(path: string): string {
  const q = `?$top=500&$select=${SELECT}`;
  return isRoot(path)
    ? `${GRAPH}/me/drive/root/children${q}`
    : `${GRAPH}/me/drive/root:/${encodePath(path)}:/children${q}`;
}

export function itemUrl(path: string): string {
  return isRoot(path)
    ? `${GRAPH}/me/drive/root?$select=${SELECT}`
    : `${GRAPH}/me/drive/root:/${encodePath(path)}?$select=${SELECT}`;
}

export function contentUrl(path: string): string {
  return `${GRAPH}/me/drive/root:/${encodePath(path)}:/content`;
}

export function uploadSessionUrl(path: string): string {
  return `${GRAPH}/me/drive/root:/${encodePath(path)}:/createUploadSession`;
}

/** Parent-children collection URL for creating a child (folder/small file). */
export function parentChildrenUrl(parentPath: string): string {
  return isRoot(parentPath)
    ? `${GRAPH}/me/drive/root/children`
    : `${GRAPH}/me/drive/root:/${encodePath(parentPath)}:/children`;
}

/** Map a Graph DriveItem to an FsEntry at the given absolute POSIX path. */
export function driveItemToEntry(item: DriveItem, path: string): FsEntry {
  return {
    name: item.name,
    path,
    kind: item.folder ? 'dir' : 'file',
    size: item.size,
    mtime: item.lastModifiedDateTime ? Date.parse(item.lastModifiedDateTime) : undefined,
    raw: item,
  };
}

// ---- Network plumbing ------------------------------------------------------

function withAuth(init: RequestInit, token: string): RequestInit {
  return { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` } };
}

async function safeErrorText(res: Response): Promise<string> {
  try {
    const data = await res.json();
    return data?.error?.message ?? res.statusText;
  } catch {
    return res.statusText || `HTTP ${res.status}`;
  }
}

async function graphFetch(auth: Authable, url: string, init: RequestInit = {}): Promise<Response> {
  // Silent token first; force an interactive prompt only as a last resort. All
  // OneDriveFS callers are user-initiated, so a re-auth prompt here is acceptable.
  let token = await auth.getToken(false);
  let forced = false;
  if (!token) {
    token = await auth.getToken(true);
    forced = true;
  }
  if (!token) throw new GraphError(401, 'Not signed in to OneDrive.');
  let res = await fetch(url, withAuth(init, token));
  if (res.status === 401 && !forced) {
    const fresh = await auth.getToken(true);
    if (fresh) res = await fetch(url, withAuth(init, fresh));
  }
  if (!res.ok) throw new GraphError(res.status, await safeErrorText(res));
  return res;
}

// ---- Operations ------------------------------------------------------------

export async function listChildren(auth: Authable, path: string): Promise<DriveItem[]> {
  const out: DriveItem[] = [];
  let url: string | undefined = childrenUrl(path);
  while (url) {
    const res = await graphFetch(auth, url);
    const data = (await res.json()) as { value?: DriveItem[]; '@odata.nextLink'?: string };
    out.push(...(data.value ?? []));
    url = data['@odata.nextLink'];
  }
  return out;
}

export async function getItem(auth: Authable, path: string): Promise<DriveItem> {
  const res = await graphFetch(auth, itemUrl(path));
  return (await res.json()) as DriveItem;
}

export async function createFolder(auth: Authable, parentPath: string, name: string): Promise<void> {
  await graphFetch(auth, parentChildrenUrl(parentPath), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
  });
}

export async function deleteItem(auth: Authable, path: string): Promise<void> {
  if (isRoot(path)) throw new GraphError(400, 'Refusing to delete the drive root.');
  await graphFetch(auth, itemUrl(path).split('?')[0], { method: 'DELETE' });
}

/** Rename and/or move: PATCH name and/or parentReference.path. */
export async function patchItem(
  auth: Authable,
  path: string,
  changes: { name?: string; newParentPath?: string },
): Promise<void> {
  if (isRoot(path)) throw new GraphError(400, 'Refusing to rename/move the drive root.');
  const body: Record<string, unknown> = {};
  if (changes.name !== undefined) body.name = changes.name;
  if (changes.newParentPath !== undefined) {
    const p = encodePath(changes.newParentPath);
    body.parentReference = { path: p ? `/drive/root:/${p}` : '/drive/root:' };
  }
  await graphFetch(auth, itemUrl(path).split('?')[0], {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Download a byte range [start,end] inclusive. */
export async function downloadRange(
  auth: Authable,
  path: string,
  start: number,
  end: number,
): Promise<ArrayBuffer> {
  const res = await graphFetch(auth, contentUrl(path), {
    headers: { Range: `bytes=${start}-${end}` },
  });
  return res.arrayBuffer();
}

/** Simple upload for small files (<= 4 MB). */
export async function uploadSmall(auth: Authable, path: string, data: Uint8Array): Promise<void> {
  await graphFetch(auth, contentUrl(path), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: data as BodyInit,
  });
}

/** Create a resumable upload session; returns the pre-authenticated uploadUrl. */
export async function createUploadSession(auth: Authable, path: string): Promise<string> {
  const res = await graphFetch(auth, uploadSessionUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }),
  });
  const { uploadUrl } = (await res.json()) as { uploadUrl: string };
  return uploadUrl;
}

/** PUT one chunk to an upload session. The uploadUrl is pre-authenticated. */
export async function putUploadChunk(
  uploadUrl: string,
  chunk: Uint8Array,
  start: number,
  total: number,
): Promise<void> {
  const end = start + chunk.byteLength - 1;
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Range': `bytes ${start}-${end}/${total}` },
    body: chunk as BodyInit,
  });
  if (!res.ok && res.status !== 202) {
    throw new GraphError(res.status, await safeErrorText(res));
  }
}

/** Cancel/roll back a resumable upload session. Never throws. */
export async function cancelUpload(uploadUrl: string): Promise<void> {
  try {
    await fetch(uploadUrl, { method: 'DELETE' });
  } catch {
    /* ignore */
  }
}
```

- [ ] **Step 2: Write `src/onedrive/graph.test.ts`** (pure builders + mapping)

```ts
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
```

- [ ] **Step 3:** Run `npx vitest run src/onedrive/graph.test.ts` — expect pass.
- [ ] **Step 4:** Commit: `git add src/onedrive/graph.ts src/onedrive/graph.test.ts && git commit -m "feat: path-addressed OneDrive Graph client"`

---

## Task 2D: OneDriveFS (FileSystem implementation)

**Files:** Create `src/onedrive/OneDriveFS.ts`, `src/onedrive/OneDriveFS.test.ts`

- [ ] **Step 1: Write `src/onedrive/OneDriveFS.ts`**

```ts
import {
  FsError,
  joinPath,
  parentPath,
  sortEntries,
  type FileSystem,
  type FsEntry,
  type ReadHandle,
  type WriteHandle,
} from '../fs/FileSystem';
import {
  GraphError,
  type Authable,
  createFolder,
  createUploadSession,
  cancelUpload,
  deleteItem,
  downloadRange,
  driveItemToEntry,
  getItem,
  listChildren,
  patchItem,
  putUploadChunk,
  uploadSmall,
} from './graph';

const ALIGN = 320 * 1024; // Graph requires upload chunks to be multiples of 320 KiB
const FLUSH_AT = 10 * ALIGN; // ~3.2 MB buffered before a streamed flush
const SIMPLE_LIMIT = 4 * 1024 * 1024; // <=4 MB → single PUT

function mapError(e: unknown): FsError {
  if (e instanceof FsError) return e;
  if (e instanceof GraphError) {
    const code =
      e.status === 404
        ? 'not-found'
        : e.status === 409
          ? 'exists'
          : e.status === 403
            ? 'permission'
            : 'io';
    return new FsError(code, e.message, e);
  }
  return new FsError('io', e instanceof Error ? e.message : String(e), e);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
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

/** OneDrive file system, addressing items by POSIX path via Microsoft Graph. */
export class OneDriveFS implements FileSystem {
  readonly kind = 'onedrive' as const;

  constructor(
    private readonly auth: Authable,
    readonly label = 'OneDrive',
  ) {}

  async list(path: string): Promise<FsEntry[]> {
    try {
      const items = await listChildren(this.auth, path);
      return sortEntries(items.map((it) => driveItemToEntry(it, joinPath(path, it.name))));
    } catch (e) {
      throw mapError(e);
    }
  }

  async stat(path: string): Promise<FsEntry> {
    try {
      const item = await getItem(this.auth, path);
      return driveItemToEntry(item, path);
    } catch (e) {
      throw mapError(e);
    }
  }

  async mkdir(path: string): Promise<void> {
    try {
      await createFolder(this.auth, parentPath(path), basename(path));
    } catch (e) {
      throw mapError(e);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    try {
      const changes: { name?: string; newParentPath?: string } = {};
      if (basename(from) !== basename(to)) changes.name = basename(to);
      if (parentPath(from) !== parentPath(to)) changes.newParentPath = parentPath(to);
      if (Object.keys(changes).length) await patchItem(this.auth, from, changes);
    } catch (e) {
      throw mapError(e);
    }
  }

  async move(from: string, to: string): Promise<void> {
    return this.rename(from, to);
  }

  async remove(path: string, recursive: boolean): Promise<void> {
    try {
      const item = await getItem(this.auth, path);
      if (item.folder && !recursive && (item.folder.childCount ?? 0) > 0) {
        throw new FsError('not-empty', `Directory not empty: ${path}`);
      }
      await deleteItem(this.auth, path);
    } catch (e) {
      throw mapError(e);
    }
  }

  async openRead(path: string): Promise<ReadHandle> {
    let size: number;
    try {
      const item = await getItem(this.auth, path);
      if (item.folder) throw new FsError('not-a-file', `Not a file: ${path}`);
      size = item.size ?? 0;
    } catch (e) {
      throw mapError(e);
    }
    const auth = this.auth;
    let offset = 0;
    return {
      size,
      async read(into: Uint8Array): Promise<number> {
        if (offset >= size) return 0;
        const want = Math.min(into.byteLength, size - offset);
        try {
          const buf = await downloadRange(auth, path, offset, offset + want - 1);
          const bytes = new Uint8Array(buf);
          into.set(bytes.subarray(0, want));
          offset += bytes.byteLength;
          return bytes.byteLength;
        } catch (e) {
          throw mapError(e);
        }
      },
      async close() {},
    };
  }

  async openWrite(path: string, size?: number): Promise<WriteHandle> {
    const auth = this.auth;
    // Unknown length: buffer, then upload on close.
    if (size === undefined) {
      const parts: Uint8Array[] = [];
      return {
        async write(chunk) {
          parts.push(chunk.slice());
        },
        async close() {
          const data = concat(parts);
          try {
            if (data.byteLength <= SIMPLE_LIMIT) {
              await uploadSmall(auth, path, data);
            } else {
              const url = await createUploadSession(auth, path);
              for (let o = 0; o < data.byteLength; o += FLUSH_AT) {
                await putUploadChunk(url, data.subarray(o, Math.min(o + FLUSH_AT, data.byteLength)), o, data.byteLength);
              }
            }
          } catch (e) {
            throw mapError(e);
          }
        },
        async abort() {},
      };
    }

    // Known length: stream to a resumable session in 320 KiB-aligned chunks.
    let url: string | null = null;
    let pending = new Uint8Array(0);
    let sent = 0;
    const total = size;
    const ensure = async () => {
      if (!url) url = await createUploadSession(auth, path);
      return url;
    };
    return {
      async write(chunk) {
        try {
          pending = concat([pending, chunk]);
          const alignedReady = Math.floor(pending.byteLength / ALIGN) * ALIGN;
          // Only flush full-aligned blocks that are NOT the final bytes.
          if (alignedReady >= ALIGN && sent + alignedReady < total) {
            const u = await ensure();
            await putUploadChunk(u, pending.subarray(0, alignedReady), sent, total);
            sent += alignedReady;
            pending = pending.slice(alignedReady);
          }
        } catch (e) {
          throw mapError(e);
        }
      },
      async close() {
        try {
          if (total <= SIMPLE_LIMIT && sent === 0) {
            await uploadSmall(auth, path, pending);
            return;
          }
          const u = await ensure();
          // Final chunk (may be unaligned) completes the session.
          await putUploadChunk(u, pending, sent, total);
        } catch (e) {
          throw mapError(e);
        }
      },
      async abort() {
        if (url) await cancelUpload(url);
      },
    };
  }
}
```

- [ ] **Step 2: Write `src/onedrive/OneDriveFS.test.ts`** — mock `./graph` so no network is used.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// `vi.hoisted` guarantees `g` exists before the hoisted `vi.mock` factory runs,
// so the factory can safely spread the spies over the real module.
const g = vi.hoisted(() => ({
  listChildren: vi.fn(),
  getItem: vi.fn(),
  createFolder: vi.fn(),
  deleteItem: vi.fn(),
  patchItem: vi.fn(),
  downloadRange: vi.fn(),
  uploadSmall: vi.fn(),
  createUploadSession: vi.fn(),
  putUploadChunk: vi.fn(),
  cancelUpload: vi.fn(),
}));

vi.mock('./graph', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./graph')>();
  return { ...actual, ...g };
});

import { OneDriveFS } from './OneDriveFS';
import { FsError } from '../fs/FileSystem';
import { GraphError } from './graph';

const auth = { getToken: async () => 'token' };

beforeEach(() => {
  Object.values(g).forEach((fn) => fn.mockReset());
});

describe('OneDriveFS listing', () => {
  it('maps and sorts children (folders first)', async () => {
    g.listChildren.mockResolvedValue([
      { id: '1', name: 'zeta.txt', size: 1, file: {} },
      { id: '2', name: 'Apps', folder: {} },
    ]);
    const fs = new OneDriveFS(auth);
    const entries = await fs.list('/');
    expect(entries.map((e) => e.name)).toEqual(['Apps', 'zeta.txt']);
    expect(entries[0].path).toBe('/Apps');
  });

  it('maps a 404 to FsError not-found', async () => {
    g.listChildren.mockRejectedValue(new GraphError(404, 'nope'));
    const fs = new OneDriveFS(auth);
    await expect(fs.list('/missing')).rejects.toMatchObject({ code: 'not-found' });
    await expect(fs.list('/missing')).rejects.toBeInstanceOf(FsError);
  });
});

describe('OneDriveFS remove', () => {
  it('refuses a non-empty folder without recursive', async () => {
    g.getItem.mockResolvedValue({ id: '1', name: 'D', folder: { childCount: 3 } });
    const fs = new OneDriveFS(auth);
    await expect(fs.remove('/D', false)).rejects.toMatchObject({ code: 'not-empty' });
    expect(g.deleteItem).not.toHaveBeenCalled();
  });

  it('deletes a file', async () => {
    g.getItem.mockResolvedValue({ id: '1', name: 'a.txt', file: {} });
    g.deleteItem.mockResolvedValue(undefined);
    const fs = new OneDriveFS(auth);
    await fs.remove('/a.txt', false);
    expect(g.deleteItem).toHaveBeenCalledWith(auth, '/a.txt');
  });
});

describe('OneDriveFS rename', () => {
  it('renames within the same folder (name only)', async () => {
    g.patchItem.mockResolvedValue(undefined);
    const fs = new OneDriveFS(auth);
    await fs.rename('/a.txt', '/b.txt');
    expect(g.patchItem).toHaveBeenCalledWith(auth, '/a.txt', { name: 'b.txt' });
  });

  it('moves to another folder (parent + maybe name)', async () => {
    g.patchItem.mockResolvedValue(undefined);
    const fs = new OneDriveFS(auth);
    await fs.rename('/a.txt', '/sub/a.txt');
    expect(g.patchItem).toHaveBeenCalledWith(auth, '/a.txt', { newParentPath: '/sub' });
  });
});

describe('OneDriveFS openRead', () => {
  it('streams ranged reads and signals EOF', async () => {
    g.getItem.mockResolvedValue({ id: '1', name: 'a', file: {}, size: 5 });
    g.downloadRange.mockImplementation(async (_a, _p, start: number, end: number) =>
      new Uint8Array([1, 2, 3, 4, 5].slice(start, end + 1)).buffer,
    );
    const fs = new OneDriveFS(auth);
    const r = await fs.openRead('/a');
    const b = new Uint8Array(3);
    expect(await r.read(b)).toBe(3);
    expect(Array.from(b)).toEqual([1, 2, 3]);
    const b2 = new Uint8Array(3);
    expect(await r.read(b2)).toBe(2);
    expect(await r.read(new Uint8Array(3))).toBe(0);
  });

  it('throws not-a-file on a folder', async () => {
    g.getItem.mockResolvedValue({ id: '1', name: 'D', folder: {} });
    const fs = new OneDriveFS(auth);
    await expect(fs.openRead('/D')).rejects.toMatchObject({ code: 'not-a-file' });
  });
});

describe('OneDriveFS openWrite', () => {
  it('uses a single PUT for a small known-size file', async () => {
    g.uploadSmall.mockResolvedValue(undefined);
    const fs = new OneDriveFS(auth);
    const w = await fs.openWrite('/small.bin', 3);
    await w.write(new Uint8Array([1, 2, 3]));
    await w.close();
    expect(g.uploadSmall).toHaveBeenCalledTimes(1);
    expect(g.createUploadSession).not.toHaveBeenCalled();
  });

  it('abort cancels an open upload session', async () => {
    g.createUploadSession.mockResolvedValue('https://upload');
    g.putUploadChunk.mockResolvedValue(undefined);
    g.cancelUpload.mockResolvedValue(undefined);
    const big = 5 * 1024 * 1024; // > SIMPLE_LIMIT so a session is created
    const fs = new OneDriveFS(auth);
    const w = await fs.openWrite('/big.bin', big);
    // one aligned flush to open the session
    await w.write(new Uint8Array(10 * 320 * 1024));
    await w.abort();
    expect(g.cancelUpload).toHaveBeenCalledWith('https://upload');
  });
});
```

- [ ] **Step 3:** Run `npx vitest run src/onedrive/OneDriveFS.test.ts` — expect all pass.
- [ ] **Step 4:** Commit: `git add src/onedrive/OneDriveFS.ts src/onedrive/OneDriveFS.test.ts && git commit -m "feat: OneDriveFS implementing the FileSystem contract"`

---

## Task 2E: Session state + sign-in UI wiring

**Files:** Modify `src/state/AppProvider.tsx`, `src/ui/MenuBar.tsx`; Create `src/ui/AccountButton.tsx`, `src/ui/ConnectHint.tsx`

- [ ] **Step 1: Create `src/ui/ConnectHint.tsx`** (shown in the local pane before sign-in)

```tsx
interface Props {
  connecting: boolean;
  error?: string | null;
  onConnect: () => void;
}

export function ConnectHint({ connecting, error, onConnect }: Props) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 p-6 text-center">
      <div className="text-muted">Your files live in OneDrive.</div>
      <button
        className="h-8 px-4 rounded bg-accent text-accent-fg disabled:opacity-60"
        onClick={onConnect}
        disabled={connecting}
      >
        {connecting ? 'Connecting…' : 'Connect OneDrive'}
      </button>
      {error && <div className="text-danger text-[12px] max-w-xs">{error}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Create `src/ui/AccountButton.tsx`**

```tsx
interface Props {
  signedIn: boolean;
  userName?: string;
  onConnect: () => void;
  onDisconnect: () => void;
}

export function AccountButton({ signedIn, userName, onConnect, onDisconnect }: Props) {
  if (!signedIn) {
    return (
      <button className="px-2 h-7 rounded text-text hover:bg-black/5 dark:hover:bg-white/10" onClick={onConnect}>
        Connect OneDrive
      </button>
    );
  }
  return (
    <button
      className="px-2 h-7 rounded text-text hover:bg-black/5 dark:hover:bg-white/10"
      title="Disconnect OneDrive"
      onClick={onDisconnect}
    >
      👤 {userName ?? 'OneDrive'} · Sign out
    </button>
  );
}
```

- [ ] **Step 3: Rewrite `src/state/AppProvider.tsx`** to own OneDrive session state and expose it.

```tsx
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useTheme, type ThemeApi } from '../theme/useTheme';
import { MockFS } from '../fs/MockFS';
import type { FileSystem } from '../fs/FileSystem';
import { OneDriveFS } from '../onedrive/OneDriveFS';
import {
  oneDriveAuth,
  connectOneDrive,
  clearOneDriveSession,
  trySilentOneDrive,
} from '../onedrive/auth';
import { sdkGetUser } from '../sdk/client';

interface AppState {
  theme: ThemeApi;
  local: FileSystem | null; // null until OneDrive is connected
  remote: FileSystem | null;
  connecting: boolean;
  connectError: string | null;
  userName?: string;
  connect: () => void;
  disconnect: () => void;
  splitRatio: number;
  setSplitRatio: (r: number) => void;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const [splitRatio, setSplitRatio] = useState(0.5);
  const [signedIn, setSignedIn] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [userName, setUserName] = useState<string | undefined>(undefined);

  const local = useMemo<FileSystem | null>(
    () => (signedIn ? new OneDriveFS(oneDriveAuth, userName ? `OneDrive · ${userName}` : 'OneDrive') : null),
    [signedIn, userName],
  );
  // Remote stays a mock until Plan 4 (SFTP).
  const remote = useMemo(() => new MockFS('deploy@host'), []);

  const refreshUser = useCallback(async () => {
    const u = await sdkGetUser();
    setUserName(u?.displayName ?? u?.name ?? u?.email ?? undefined);
  }, []);

  // Attempt a silent reconnect on mount (no OAuth popup).
  useEffect(() => {
    let alive = true;
    trySilentOneDrive().then(async (ok) => {
      if (!alive) return;
      if (ok) {
        setSignedIn(true);
        await refreshUser();
      }
    });
    return () => {
      alive = false;
    };
  }, [refreshUser]);

  const connect = useCallback(() => {
    setConnecting(true);
    setConnectError(null);
    connectOneDrive().then(async (res) => {
      setConnecting(false);
      if (res.ok) {
        setSignedIn(true);
        await refreshUser();
      } else {
        setConnectError(res.detail ?? 'Could not connect to OneDrive.');
      }
    });
  }, [refreshUser]);

  const disconnect = useCallback(() => {
    clearOneDriveSession().then(() => {
      setSignedIn(false);
      setUserName(undefined);
    });
  }, []);

  const value: AppState = {
    theme,
    local,
    remote,
    connecting,
    connectError,
    userName,
    connect,
    disconnect,
    splitRatio,
    setSplitRatio,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp must be used within AppProvider');
  return v;
}
```

- [ ] **Step 4: Update `src/ui/MenuBar.tsx`** to host the AccountButton. Replace its body:

```tsx
import { IconMoon, IconSun } from './icons';
import type { ThemeApi } from '../theme/useTheme';
import { AccountButton } from './AccountButton';

interface Props {
  sessionLabel: string;
  theme: ThemeApi;
  compact?: boolean;
  signedIn: boolean;
  userName?: string;
  onConnect: () => void;
  onDisconnect: () => void;
}

export function MenuBar({ sessionLabel, theme, compact, signedIn, userName, onConnect, onDisconnect }: Props) {
  return (
    <div className="flex items-center gap-3 px-3 h-9 bg-surface border-b border-border select-none">
      <span className="font-semibold">WinSCP Web</span>
      {!compact && <span className="text-muted">Session: {sessionLabel}</span>}
      <div className="ml-auto flex items-center gap-1">
        <AccountButton signedIn={signedIn} userName={userName} onConnect={onConnect} onDisconnect={onDisconnect} />
        <button
          className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/10 text-text"
          title="Toggle light/dark"
          onClick={theme.toggle}
        >
          {theme.theme === 'dark' ? <IconSun /> : <IconMoon />}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Update the three layouts** to pass the new MenuBar props and render `ConnectHint` in the local pane when `local` is null.

In `src/layouts/Commander.tsx`: destructure `const { theme, local, remote, splitRatio, setSplitRatio, signedIn: _si, connecting, connectError, userName, connect, disconnect } = useApp();` — actually derive `signedIn` from `local !== null`. Pass to MenuBar: `signedIn={local !== null} userName={userName} onConnect={connect} onDisconnect={disconnect}`. In the left pane, render `{local ? <PaneView fs={local} header={local.label} /> : <ConnectHint connecting={connecting} error={connectError} onConnect={connect} />}`.

In `src/layouts/TabbedSingle.tsx`: same MenuBar props; when the active side is `local` and `local` is null, render `<ConnectHint ... />` instead of PaneView.

In `src/layouts/StatusTile.tsx`: no MenuBar; leave as-is (it shows remote session only).

(Exact edits are mechanical; the implementer wires `useApp()`'s new fields through. `AppState` now exposes `connect/disconnect/connecting/connectError/userName` and `local: FileSystem | null`.)

- [ ] **Step 6:** Run `npx tsc -p tsconfig.app.json --noEmit` (expect clean) and `npx vitest run` (expect all prior tests + new ones green).
- [ ] **Step 7:** Commit: `git add src/state src/ui src/layouts && git commit -m "feat: OneDrive connect/disconnect flow and sign-in UI"`

---

## Task 2F: Build + integration verification

- [ ] **Step 1:** Run `npm test` — all suites green.
- [ ] **Step 2:** Run `npm run build` — exit 0, static-only `dist/`. Fix any type error minimally and report.
- [ ] **Step 3:** Confirm `dist/` remains static-only (no server entry).
- [ ] **Step 4:** Commit any build-only fixes: `git commit -am "chore: verify OneDrive integration builds"` (only if changes were needed).

---

## Self-Review

**Spec coverage (Plan 2 slice of the Phase 1 spec):**
- §1 local side = OneDrive via host OAuth — Tasks 2A/2B/2C/2D/2E. ✓
- §2.2 no local disk (all I/O is Graph over the network) — OneDriveFS. ✓
- §2.3 all host comms via ai-publish-sdk — `sdk/client.ts` only. ✓
- §3.2 FileSystem seam unchanged; OneDriveFS implements it — Task 2D. ✓
- §5 (partial): OneDrive session is host-managed; no credentials stored by us. ✓ (SFTP vault is Plan 5.)
- §6 streaming I/O primitives (ranged read, resumable upload) ready for the transfer engine — Task 2D. ✓
- Remote SFTP, vault, transfer engine — deferred to Plans 3-6.

**Placeholder scan:** remote pane remains MockFS by design (Plan 4 replaces it); no TBDs in steps.

**Type consistency:** `Authable` (graph.ts) is what `oneDriveAuth` (auth.ts) satisfies and `OneDriveFS` consumes; `OneDriveTokenResult` shared by client.ts/session.ts; `FsError` codes match the union defined in Plan 1's `FileSystem.ts`; `AppState.local: FileSystem | null` consumed by all three layouts.
