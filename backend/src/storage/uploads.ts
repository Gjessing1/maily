/**
 * Staging for outbound attachments uploaded from the composer (ROADMAP §3.7.B).
 * Unlike incoming attachments (lazy, fetched from IMAP on demand — ARCHITECTURE
 * §4), these are user-provided files we hold briefly on disk until the message is
 * sent, then delete. Bytes are streamed to disk on upload, never buffered.
 */
import { existsSync, statSync } from 'node:fs';
import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '../env.js';
import { createLogger } from '../logger.js';

const log = createLogger('uploads');

/** Staged uploads older than this are swept (abandoned composes). */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve an upload id to its on-disk path, or null if the id is malformed. */
export function uploadPath(uploadId: string): string | null {
  if (!UUID_RE.test(uploadId)) return null;
  return join(env.uploadsDir, uploadId);
}

/** Read a staged upload as a stream (for nodemailer), or null if missing/invalid. */
export function openUpload(uploadId: string): { path: string; size: number } | null {
  const path = uploadPath(uploadId);
  if (!path || !existsSync(path)) return null;
  return { path, size: statSync(path).size };
}

/** Delete a staged upload (after send, or when the user removes the chip). */
export async function deleteUpload(uploadId: string): Promise<void> {
  const path = uploadPath(uploadId);
  if (path && existsSync(path)) {
    await unlink(path).catch(() => undefined);
  }
}

/** Drop abandoned staged uploads. Called opportunistically on boot. */
export async function sweepStaleUploads(): Promise<void> {
  try {
    const cutoff = Date.now() - MAX_AGE_MS;
    const names = await readdir(env.uploadsDir);
    for (const name of names) {
      const path = join(env.uploadsDir, name);
      try {
        if (statSync(path).mtimeMs < cutoff) await unlink(path);
      } catch {
        // Best-effort sweep; ignore files that vanish mid-pass.
      }
    }
  } catch (err) {
    log.warn('upload sweep failed:', (err as Error).message);
  }
}
