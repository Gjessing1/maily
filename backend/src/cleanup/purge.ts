/**
 * Local "Purge Trash" (ROADMAP storage / vendor-independence companion to the detach archive).
 * Permanently reclaims the LOCAL disk used by a trash folder's messages — unlinks the raw `.eml`
 * (`source_path`) and any downloaded attachment files, and nulls the body/source columns — while
 * keeping a lightweight tombstone row.
 *
 * The row + its identity (`message_id`/`gm_msg_id`) + its trash folder mapping are deliberately
 * KEPT and flagged `purged_at`, so the provider's still-present Trash copy is NOT re-downloaded on
 * the next sync: `upsertMessage` dedups on those ids and, on a hit, only touches mappings/flags —
 * it never re-stores a body (store.ts). Deliberately local-only: no provider EXPUNGE; the provider
 * auto-purges its own Trash on its own schedule.
 *
 * Nulling `body_text` + `snippet` lets the `messages_fts_au` trigger drop the body from the FTS
 * index on the same UPDATE (drizzle/0003,0018), so search reclaims too with no extra step.
 */
import { rmSync } from 'node:fs';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, withWriteRetry } from '../db/client.js';
import { attachments, folders, messageFolders, messages } from '../db/schema.js';
import { emitSignal } from '../events.js';
import { bumpCleanupCache } from './cache.js';
import { createLogger } from '../logger.js';

const log = createLogger('cleanup-purge');

/** Update/unlink chunk — keeps a single statement well under SQLite's bound-variable cap. */
const CHUNK = 500;

/**
 * Reclaim local disk for every (not-yet-purged) message in a trash folder, keeping a no-resync
 * tombstone. Throws if `folderId` is not a trash-role folder (the route validates too). Returns the
 * number of messages purged. File unlinks are best-effort — a missing file never fails the purge.
 */
export function purgeTrashFolder(folderId: string): { purged: number } {
  const folder = db.select().from(folders).where(eq(folders.id, folderId)).get();
  if (!folder || folder.role !== 'trash') {
    throw new Error(`folder '${folderId}' is not a trash folder`);
  }

  const rows = db
    .select({
      id: messages.id,
      accountId: messages.accountId,
      sourcePath: messages.sourcePath,
    })
    .from(messages)
    .innerJoin(messageFolders, eq(messageFolders.messageId, messages.id))
    .where(and(eq(messageFolders.folderId, folderId), isNull(messages.purgedAt)))
    .all();
  if (rows.length === 0) return { purged: 0 };

  const ids = rows.map((r) => r.id);
  // Downloaded attachment files (storage_path null = never fetched, nothing on disk to unlink).
  const attFiles = db
    .select({ storagePath: attachments.storagePath })
    .from(attachments)
    .where(inArray(attachments.messageId, ids))
    .all()
    .map((a) => a.storagePath)
    .filter((p): p is string => !!p);

  const now = new Date();
  withWriteRetry('purgeTrashFolder', () =>
    db.transaction(() => {
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        db.delete(attachments).where(inArray(attachments.messageId, chunk)).run();
        db.update(messages)
          .set({
            bodyText: null,
            bodyHtml: null,
            bodyCalendar: null,
            snippet: null,
            contentBytes: null,
            sourcePath: null,
            sourceBytes: null,
            // Purged implies trashed; stamp both so the row is hidden everywhere (queries.ts).
            deletedAt: now,
            purgedAt: now,
          })
          .where(inArray(messages.id, chunk))
          .run();
      }
    }),
  );

  // Unlink the reclaimed files AFTER the rows are detached from them. Best-effort: the row is
  // already purged, so a leftover file is at worst wasted disk, never a correctness problem.
  for (const path of [
    ...rows.map((r) => r.sourcePath).filter((p): p is string => !!p),
    ...attFiles,
  ]) {
    try {
      rmSync(path, { force: true });
    } catch (err) {
      log.warn(`purge: could not unlink ${path}: ${(err as Error).message}`);
    }
  }

  // Drop the rows from any live client's cache, and refresh cleanup analytics.
  for (const r of rows) {
    emitSignal({ type: 'mail:deleted', accountId: r.accountId, messageId: r.id });
  }
  bumpCleanupCache();

  log.info(`purged ${rows.length} message(s) from trash folder ${folderId}`);
  return { purged: rows.length };
}
