import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import type { SupabaseLike } from './types';

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.json': 'application/json',
};

/**
 * File-shaped access to a Supabase Storage bucket: the worker moves artifacts
 * between its scratch disk and the bucket. Uploads are idempotent
 * (upsert: true), so re-syncing after a resume is harmless.
 */
export class SupabaseBlobStore {
  constructor(
    private client: SupabaseLike,
    private bucket: string,
  ) {}

  async uploadFile(remotePath: string, localPath: string): Promise<void> {
    const bytes = await readFile(localPath);
    const contentType = CONTENT_TYPES[extname(localPath).toLowerCase()] ?? 'application/octet-stream';
    const { error } = await this.client.storage
      .from(this.bucket)
      .upload(remotePath, bytes, { contentType, upsert: true });
    if (error) throw new Error(`upload ${remotePath} failed: ${error.message}`);
  }

  async downloadToFile(remotePath: string, localPath: string): Promise<void> {
    const { data, error } = await this.client.storage.from(this.bucket).download(remotePath);
    if (error || !data) throw new Error(`download ${remotePath} failed: ${error?.message ?? 'no data'}`);
    await mkdir(dirname(localPath), { recursive: true });
    await writeFile(localPath, Buffer.from(await data.arrayBuffer()));
  }

  async signedUrl(remotePath: string, expiresInSec = 3600): Promise<string> {
    const { data, error } = await this.client.storage
      .from(this.bucket)
      .createSignedUrl(remotePath, expiresInSec);
    if (error || !data) throw new Error(`sign ${remotePath} failed: ${error?.message ?? 'no data'}`);
    return data.signedUrl;
  }
}
