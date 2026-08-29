// S3Connection: builds a ready-to-use FileSystem over Amazon S3 (or an
// S3-compatible endpoint), verifying credentials/access up front.

import type { FileSystem } from '../fs/FileSystem';
import { FsError } from '../fs/FileSystem';
import { S3FS, type S3Config } from './S3FS';

export interface S3Credentials {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  forcePathStyle?: boolean;
}

export interface S3Connection {
  fs: FileSystem;
  home: string;
  close(): Promise<void>;
}

/**
 * Connect to an S3 bucket and return a ready `FileSystem`. Access is verified
 * with a cheap `list-type=2&max-keys=1` request so bad credentials, a missing
 * bucket, or the wrong region fail here rather than on first use.
 */
export async function connectS3(creds: S3Credentials, label?: string): Promise<S3Connection> {
  const cfg: S3Config = { ...creds };
  const fs = new S3FS(cfg, label);

  // Verify access: list the bucket root with max-keys=1.
  const res = await fs.request('GET', '', {
    query: { 'list-type': '2', 'max-keys': '1' },
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      // ignore
    }
    const code =
      res.status === 403 ? 'permission' : res.status === 404 ? 'not-found' : 'io';
    throw new FsError(code, `S3 connect failed (${res.status}) for ${creds.bucket}: ${detail}`);
  }

  return {
    fs,
    home: '/',
    close: async () => {
      /* no persistent connection to tear down */
    },
  };
}
