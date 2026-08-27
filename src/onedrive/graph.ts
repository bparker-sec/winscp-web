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
  // OneDriveFS callers are user-initiated (browsing/transfer off a click), so a
  // re-auth prompt here is acceptable rather than surprising.
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
    // A bare '/drive/root:' moves the item to the drive root.
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
