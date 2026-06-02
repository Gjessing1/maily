/**
 * Lazy attachment materialisation (ARCHITECTURE §4): attachment bytes are stored
 * as metadata only at sync time and pulled from IMAP on demand, streamed straight
 * to disk. This helper is shared by the attachment download route and the send
 * path (forwarding re-attaches an existing message's files).
 */
import { createWriteStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { env } from '../env.js';
import type { AttachmentRow } from '../db/queries.js';
import { markAttachmentDownloaded, uidLocationForMessage } from '../db/queries.js';
import { withTransientConnection } from '../imap/connection.js';
import { getEngine } from '../imap/registry.js';

/**
 * Ensure an attachment's bytes exist on local disk, fetching them from IMAP over a
 * transient connection if not yet downloaded. Returns the on-disk path, or null if
 * the bytes can't be obtained (no IMAP location / part id / live engine).
 */
export async function ensureAttachmentOnDisk(att: AttachmentRow): Promise<string | null> {
  if (att.storagePath && existsSync(att.storagePath)) return att.storagePath;

  const loc = uidLocationForMessage(att.messageId);
  const engine = loc ? getEngine(loc.accountId) : undefined;
  if (!loc || !engine || !att.imapPartId) return null;

  const path = join(env.attachmentsDir, att.id);
  await withTransientConnection(engine.accountConfig, async (client) => {
    const lock = await client.getMailboxLock(loc.folderPath);
    try {
      const { content } = await client.download(String(loc.uid), att.imapPartId!, { uid: true });
      await pipeline(content, createWriteStream(path));
    } finally {
      lock.release();
    }
  });
  markAttachmentDownloaded(att.id, path, statSync(path).size);
  return path;
}
