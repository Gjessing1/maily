/**
 * Lazy attachment materialisation (ARCHITECTURE §4): attachment bytes are stored
 * as metadata only at sync time and pulled from IMAP on demand, streamed straight
 * to disk. This helper is shared by the attachment download route and the send
 * path (forwarding re-attaches an existing message's files).
 */
import { createWriteStream, existsSync, statSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { env } from '../env.js';
import { createLogger } from '../logger.js';
import type { AttachmentRow } from '../db/queries.js';
import {
  accountIdForMessage,
  markAttachmentDownloaded,
  uidLocationForMessage,
} from '../db/queries.js';
import { sourcePathForMessage } from '../imap/store.js';
import { extractPartFromSource } from '../imap/source-extract.js';
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
 * Aggregate guards across one message body (ROADMAP §3.7 hardening). The per-image
 * cap above bounds a single image, but a newsletter with dozens of small inline
 * pixels/logos could still bloat the srcdoc and lag the reader. Cap the *cumulative*
 * embedded bytes and the *count* of embeds per body; images past either limit fall
 * back to the authenticated attachments/blob path (the caller flips their isInline
 * hint). base64 inflates ~4/3, so the on-wire srcdoc is larger than this budget.
 */
const INLINE_EMBED_TOTAL_BUDGET_BYTES = 5 * 1024 * 1024;
const INLINE_EMBED_MAX_COUNT = 20;

const log = createLogger('attachments');

/**
 * Where a freshly-materialised attachment's bytes get written (ROADMAP §3.7.E).
 * New files are partitioned `<attachmentsDir>/{account_id}/{message_uuid}/{att.id}`
 * so a message's attachments sit under the same `{account}/{message}` sub-path as its
 * source `.eml` (`storage/source.ts`) and orphan-GC can drop a whole message directory.
 * Existing flat files keep working via their stored `storage_path` (resolver step 1),
 * so this is applied to new files only — no bulk move on deploy. Falls back to the flat
 * layout only if the owning account can't be resolved (a dangling attachment row).
 */
function materialisePathFor(att: AttachmentRow): string {
  const accountId = accountIdForMessage(att.messageId);
  return accountId
    ? join(env.attachmentsDir, accountId, att.messageId, att.id)
    : join(env.attachmentsDir, att.id);
}

/**
 * The single attachment-byte resolver (ROADMAP §3.7.E). Returns the on-disk path of
 * an attachment's bytes, materialising them on demand, by trying in order:
 *   1. **Materialised** — already downloaded and present on disk.
 *   2. **Local source** — the owning message's raw `.eml` is archived
 *      (`source_path` set); stream the single MIME part out of it with zero network.
 *   3. **IMAP fallback** — not yet archived; fetch the part over a transient
 *      connection by its BODYSTRUCTURE part id.
 * Returns null if no path can serve the bytes. Once a message is archived, step 2
 * resolves with no IMAP at all, so an archived message stays fetchable even after
 * every `(folder, uid)` mapping is gone — `uidLocationForMessage` only gates step 3.
 */
export async function ensureAttachmentOnDisk(att: AttachmentRow): Promise<string | null> {
  // 1. Already on disk.
  if (att.storagePath && existsSync(att.storagePath)) return att.storagePath;

  const path = materialisePathFor(att);

  // 2. Carve the part out of the cached raw `.eml`, if the message is archived.
  const sourcePath = sourcePathForMessage(att.messageId);
  if (sourcePath && existsSync(sourcePath)) {
    const part = await extractPartFromSource(
      sourcePath,
      {
        contentId: att.contentId,
        partOrdinal: att.partOrdinal,
        // Legacy rows predating `part_ordinal` have neither key; let the extractor
        // fall back to the filename so they resolve locally instead of dropping to
        // an IMAP refetch whose stored UID may no longer exist.
        filename: att.filename,
        mimeType: att.mimeType,
      },
      path,
    );
    if (part) {
      // The (filename, mime_type) tuple is a post-match guard, not the key — a
      // mismatch means the shared classifier drifted between the two walks. Size is
      // deliberately excluded: the stored `size_bytes` is BODYSTRUCTURE's *encoded*
      // octet count, not comparable to the decoded bytes we just wrote.
      if ((att.filename ?? null) !== part.filename || (att.mimeType ?? null) !== part.mimeType) {
        log.warn(
          `local-source part mismatch for ${att.id}: ` +
            `db=(${att.filename}, ${att.mimeType}) eml=(${part.filename}, ${part.mimeType})`,
        );
      }
      markAttachmentDownloaded(att.id, path, part.sizeBytes);
      return path;
    }
  }

  // 3. Fetch from IMAP — the message isn't archived (or the part didn't resolve).
  const loc = uidLocationForMessage(att.messageId);
  const engine = loc ? getEngine(loc.accountId) : undefined;
  if (!loc || !engine || !att.imapPartId) return null;

  await mkdir(dirname(path), { recursive: true });
  const fetched = await withTransientConnection(engine.accountConfig, async (client) => {
    const lock = await client.getMailboxLock(loc.folderPath);
    try {
      // `download` resolves with an undefined `content` when the server has nothing at
      // that (mailbox, uid) — a stale mapping, e.g. a Gmail virtual folder the message
      // has since left. Report that as "bytes unavailable" (the route's 409) rather than
      // letting `pipeline(undefined, …)` throw an opaque 500.
      const res = await client.download(String(loc.uid), att.imapPartId!, { uid: true });
      if (!res?.content) {
        log.warn(
          `no IMAP bytes for ${att.id} at ${loc.folderPath}:${loc.uid} — stale uid mapping?`,
        );
        return false;
      }
      await pipeline(res.content, createWriteStream(path));
      return true;
    } finally {
      lock.release();
    }
  });
  if (!fetched) return null;
  markAttachmentDownloaded(att.id, path, statSync(path).size);
  return path;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rewrite `cid:<id>` references in an HTML body to self-contained `data:` URIs so
 * inline images render inside the locked-down, null-origin reader iframe — which
 * can neither send the JWT (header-auth attachment route 401s) nor read the
 * parent's blob URLs (ROADMAP §3.7.A). Bytes are resolved through the shared
 * resolver (`ensureAttachmentOnDisk`), so this transparently picks up the local
 * `.eml` source path once §3.7.E lands. Images over `INLINE_EMBED_CAP_BYTES`, or past
 * the per-body cumulative budget / max-count cap, are left as-is and surface through
 * the attachments panel instead.
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
  let embeddedBytes = 0;
  for (const att of candidates) {
    // Count cap: once enough images are inlined, leave the rest for the attachments
    // panel rather than growing the srcdoc unboundedly.
    if (embeddedIds.size >= INLINE_EMBED_MAX_COUNT) break;
    // Skip oversized inline images by declared size before fetching any bytes;
    // they fall back to the attachments panel (handled by the caller).
    if (att.sizeBytes !== null && att.sizeBytes > INLINE_EMBED_CAP_BYTES) continue;
    try {
      const path = await ensureAttachmentOnDisk(att);
      if (!path) continue;
      const bytes = await readFile(path);
      if (bytes.byteLength > INLINE_EMBED_CAP_BYTES) continue;
      // Cumulative budget: skip an image that would push the body over the total
      // budget (a later, smaller one may still fit) — it falls back to the panel.
      if (embeddedBytes + bytes.byteLength > INLINE_EMBED_TOTAL_BUDGET_BYTES) continue;
      const mime = att.mimeType ?? 'application/octet-stream';
      const dataUri = `data:${mime};base64,${bytes.toString('base64')}`;
      // CID scheme is case-insensitive; the id itself is matched exactly.
      out = out.replace(new RegExp(`cid:${escapeRegExp(att.contentId!)}`, 'gi'), dataUri);
      embeddedBytes += bytes.byteLength;
      embeddedIds.add(att.id);
    } catch (err) {
      log.warn(`inline embed failed for ${att.id}: ${(err as Error).message}`);
    }
  }
  return { html: out, embeddedIds };
}
