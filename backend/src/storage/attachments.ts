/**
 * Lazy attachment materialisation (ARCHITECTURE §4): attachment bytes are stored
 * as metadata only at sync time and pulled from IMAP on demand, streamed straight
 * to disk. This helper is shared by the attachment download route and the send
 * path (forwarding re-attaches an existing message's files).
 */
import { createWriteStream, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { env } from '../env.js';
import { createLogger } from '../logger.js';
import type { AttachmentRow } from '../db/queries.js';
import { markAttachmentDownloaded, uidLocationForMessage } from '../db/queries.js';
import { withTransientConnection } from '../imap/connection.js';
import { getEngine } from '../imap/registry.js';

/**
 * Upper bound on an inline image embedded as a `data:` URI in a message body
 * (ROADMAP §3.7.A). base64 inflates bytes ~4/3, and the whole body ships inside
 * the reader's srcdoc string, so cap the source bytes to keep that string small.
 * Inline images over the cap fall back to the attachments panel (authenticated
 * blob fetch), which already works.
 */
const INLINE_EMBED_CAP_BYTES = 500 * 1024;

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

const log = createLogger('attachments');

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rewrite `cid:<id>` references in an HTML body to self-contained `data:` URIs so
 * inline images render inside the locked-down, null-origin reader iframe — which
 * can neither send the JWT (header-auth attachment route 401s) nor read the
 * parent's blob URLs (ROADMAP §3.7.A). Bytes are resolved through the shared
 * resolver (`ensureAttachmentOnDisk`), so this transparently picks up the local
 * `.eml` source path once §3.7.E lands. Images over `INLINE_EMBED_CAP_BYTES` are
 * left as-is and surface through the attachments panel instead.
 */
export async function embedInlineImages(
  html: string | null,
  atts: AttachmentRow[],
): Promise<{ html: string | null; embeddedIds: Set<string> }> {
  const embeddedIds = new Set<string>();
  if (!html) return { html, embeddedIds };
  // Only inline parts that carry a CID and are actually referenced by the body.
  const candidates = atts.filter(
    (a) => a.isInline && a.contentId && html.includes(`cid:${a.contentId}`),
  );
  if (candidates.length === 0) return { html, embeddedIds };

  let out = html;
  for (const att of candidates) {
    // Skip oversized inline images by declared size before fetching any bytes;
    // they fall back to the attachments panel (handled by the caller).
    if (att.sizeBytes !== null && att.sizeBytes > INLINE_EMBED_CAP_BYTES) continue;
    try {
      const path = await ensureAttachmentOnDisk(att);
      if (!path) continue;
      const bytes = await readFile(path);
      if (bytes.byteLength > INLINE_EMBED_CAP_BYTES) continue;
      const mime = att.mimeType ?? 'application/octet-stream';
      const dataUri = `data:${mime};base64,${bytes.toString('base64')}`;
      // CID scheme is case-insensitive; the id itself is matched exactly.
      out = out.replace(new RegExp(`cid:${escapeRegExp(att.contentId!)}`, 'gi'), dataUri);
      embeddedIds.add(att.id);
    } catch (err) {
      log.warn(`inline embed failed for ${att.id}: ${(err as Error).message}`);
    }
  }
  return { html: out, embeddedIds };
}
