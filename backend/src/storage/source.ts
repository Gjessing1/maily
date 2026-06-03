/**
 * Canonical raw-RFC822 (.eml) archive on disk (ROADMAP §3.7.E / ARCHITECTURE §15).
 *
 * Files are partitioned `<sourceDir>/{account_id}/{message_uuid}/source.eml` so a
 * message's source sits beside its (lazily materialised) attachments and orphan-GC
 * can drop a whole message directory at once. We mirror the attachment streaming
 * pattern: pipe the download straight to disk, never buffer multi-MB bodies in memory.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { env } from '../env.js';

/** Absolute path of the `.eml` for a message under the partitioned layout. */
export function sourcePathFor(accountId: string, messageUuid: string): string {
  return join(env.sourceDir, accountId, messageUuid, 'source.eml');
}

/**
 * Stream a full-source download to `destPath`, creating the message directory.
 * Returns the number of bytes written (for byte-budget accounting). The stream is
 * piped straight to disk — at no point is the whole message held in memory.
 */
export async function writeSourceStream(
  content: NodeJS.ReadableStream,
  destPath: string,
): Promise<number> {
  await mkdir(dirname(destPath), { recursive: true });
  await pipeline(content, createWriteStream(destPath));
  return (await stat(destPath)).size;
}

/** Best-effort removal of a message's source file + its (now-empty) directory. */
export async function discardSource(destPath: string): Promise<void> {
  await rm(dirname(destPath), { recursive: true, force: true });
}
