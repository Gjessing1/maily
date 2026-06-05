/**
 * Read-side query helpers used by the HTTP API. Keeps route handlers thin and
 * keeps all SQL in one place. Local full-text search goes through the FTS5 index
 * (ARCHITECTURE §12 — never LIKE-scan).
 */
import {
  and,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  lt,
  notExists,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { db } from './client.js';
import {
  accounts,
  attachments,
  folders,
  messageFolders,
  messages,
  pushSubscriptions,
} from './schema.js';

export type MessageRow = typeof messages.$inferSelect;
export type AttachmentRow = typeof attachments.$inferSelect;

export function listAccounts(): (typeof accounts.$inferSelect)[] {
  return db.select().from(accounts).all();
}

export function listFolders(accountId: string): (typeof folders.$inferSelect)[] {
  return db.select().from(folders).where(eq(folders.accountId, accountId)).all();
}

/** Count of non-tombstoned messages currently mapped into a folder (cached count). */
export function folderMessageCount(folderId: string): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(messageFolders)
    .innerJoin(messages, eq(messageFolders.messageId, messages.id))
    .where(and(eq(messageFolders.folderId, folderId), isNull(messages.deletedAt)))
    .get();
  return row?.n ?? 0;
}

/** The account's folder for a given well-known role (e.g. 'trash'), if it exists. */
export function folderByRole(
  accountId: string,
  role: (typeof folders.$inferSelect)['role'],
): typeof folders.$inferSelect | undefined {
  return db
    .select()
    .from(folders)
    .where(and(eq(folders.accountId, accountId), eq(folders.role, role)))
    .get();
}

export function getMessage(id: string): MessageRow | undefined {
  return db.select().from(messages).where(eq(messages.id, id)).get();
}

/** Messages in a folder, newest first, keyset-paginated by receivedAt. Tombstones hidden (§13). */
export function listMessages(folderId: string, limit: number, beforeMs?: number): MessageRow[] {
  const where = and(
    eq(messageFolders.folderId, folderId),
    isNull(messages.deletedAt),
    beforeMs ? lt(messages.receivedAt, new Date(beforeMs)) : undefined,
  );
  return db
    .select(getTableColumns(messages))
    .from(messages)
    .innerJoin(messageFolders, eq(messageFolders.messageId, messages.id))
    .where(where)
    .orderBy(desc(messages.receivedAt))
    .limit(limit)
    .all();
}

/**
 * Virtual "Unified Inbox": every account's inbox-role folder merged into one
 * newest-first stream. Same keyset pagination as `listMessages`; tombstones hidden
 * (§13). A message lives in exactly one account's inbox so no de-dup is needed.
 */
export function listUnifiedInbox(limit: number, beforeMs?: number): MessageRow[] {
  return db
    .select(getTableColumns(messages))
    .from(messages)
    .innerJoin(messageFolders, eq(messageFolders.messageId, messages.id))
    .innerJoin(folders, eq(folders.id, messageFolders.folderId))
    .where(
      and(
        eq(folders.role, 'inbox'),
        isNull(messages.deletedAt),
        beforeMs ? lt(messages.receivedAt, new Date(beforeMs)) : undefined,
      ),
    )
    .orderBy(desc(messages.receivedAt))
    .limit(limit)
    .all();
}

/** Roles whose presence disqualifies a message from the virtual "Archived" view. */
const NON_ARCHIVE_ROLES = ['inbox', 'sent', 'trash', 'junk', 'drafts'] as const;

/**
 * Virtual "Archived" view: messages in the account's archive-role folder that are
 * NOT also in the inbox/sent/trash/junk/drafts. Gmail conflates archive with "All
 * Mail" (everything), so this subtraction is what makes "Archived" mean archived;
 * on providers with a real Archive folder the subtraction is a harmless no-op.
 * Tombstones hidden (§13); newest first, keyset-paginated by receivedAt.
 */
export function listArchived(accountId: string, limit: number, beforeMs?: number): MessageRow[] {
  const mf2 = alias(messageFolders, 'mf2');
  const f2 = alias(folders, 'f2');
  return db
    .select(getTableColumns(messages))
    .from(messages)
    .innerJoin(messageFolders, eq(messageFolders.messageId, messages.id))
    .innerJoin(folders, eq(folders.id, messageFolders.folderId))
    .where(
      and(
        eq(messages.accountId, accountId),
        eq(folders.role, 'archive'),
        isNull(messages.deletedAt),
        beforeMs ? lt(messages.receivedAt, new Date(beforeMs)) : undefined,
        notExists(
          db
            .select({ one: sql`1` })
            .from(mf2)
            .innerJoin(f2, eq(f2.id, mf2.folderId))
            .where(and(eq(mf2.messageId, messages.id), inArray(f2.role, [...NON_ARCHIVE_ROLES]))),
        ),
      ),
    )
    .orderBy(desc(messages.receivedAt))
    .limit(limit)
    .all();
}

export function folderIdsForMessage(messageId: string): string[] {
  return db
    .select({ folderId: messageFolders.folderId })
    .from(messageFolders)
    .where(eq(messageFolders.messageId, messageId))
    .all()
    .map((r) => r.folderId);
}

export function attachmentsForMessage(messageId: string): AttachmentRow[] {
  return db.select().from(attachments).where(eq(attachments.messageId, messageId)).all();
}

export function getAttachment(id: string): AttachmentRow | undefined {
  return db.select().from(attachments).where(eq(attachments.id, id)).get();
}

/**
 * Every archived message (id + on-disk `.eml` path), oldest first — the input set for
 * the offline rebuild (ROADMAP §3.7.E). Un-swept history (null `source_path`) is
 * skipped: its parsed row is its only copy, so there is nothing to rebuild from.
 */
export function messagesWithSource(): { id: string; sourcePath: string }[] {
  return db
    .select({ id: messages.id, sourcePath: messages.sourcePath })
    .from(messages)
    .where(isNotNull(messages.sourcePath))
    .orderBy(messages.receivedAt)
    .all()
    .filter((r): r is { id: string; sourcePath: string } => r.sourcePath !== null);
}

/** The owning account of a message — used to build its partitioned on-disk path (§3.7.E). */
export function accountIdForMessage(messageId: string): string | undefined {
  return db
    .select({ accountId: messages.accountId })
    .from(messages)
    .where(eq(messages.id, messageId))
    .get()?.accountId;
}

export function markAttachmentDownloaded(id: string, storagePath: string, sizeBytes: number): void {
  db.update(attachments)
    .set({ storagePath, sizeBytes, downloadedAt: new Date() })
    .where(eq(attachments.id, id))
    .run();
}

/** Any folder location (path + UID) for a message — used to fetch bytes on demand. */
export function uidLocationForMessage(
  messageId: string,
): { accountId: string; folderPath: string; uid: number } | undefined {
  const row = db
    .select({
      accountId: messages.accountId,
      folderPath: folders.path,
      uid: messageFolders.uid,
    })
    .from(messageFolders)
    .innerJoin(folders, eq(folders.id, messageFolders.folderId))
    .innerJoin(messages, eq(messages.id, messageFolders.messageId))
    .where(and(eq(messageFolders.messageId, messageId), isNotNull(messageFolders.uid)))
    .get();
  return row && row.uid !== null ? { ...row, uid: row.uid } : undefined;
}

/** A message's (path + UID) within ONE specific folder, if mapped there (for moves). */
export function uidLocationInFolder(
  messageId: string,
  folderId: string,
): { folderPath: string; uid: number } | undefined {
  const row = db
    .select({ folderPath: folders.path, uid: messageFolders.uid })
    .from(messageFolders)
    .innerJoin(folders, eq(folders.id, messageFolders.folderId))
    .where(
      and(
        eq(messageFolders.messageId, messageId),
        eq(messageFolders.folderId, folderId),
        isNotNull(messageFolders.uid),
      ),
    )
    .get();
  return row && row.uid !== null ? { folderPath: row.folderPath, uid: row.uid } : undefined;
}

/**
 * Messages whose To/Cc were never parsed (NULL — synced before the `to_addresses`
 * column existed, migration 0004). Returns one `(folderPath, uid)` location per
 * message so a low-bandwidth envelope-only refetch can heal them. Rows that have
 * been checked (even if genuinely empty) carry `'[]'`, not NULL, so they drop out.
 */
export function messagesNeedingRecipientBackfill(
  accountId: string,
): { messageId: string; folderPath: string; uid: number }[] {
  return db
    .select({
      messageId: messages.id,
      folderPath: folders.path,
      uid: messageFolders.uid,
    })
    .from(messages)
    .innerJoin(messageFolders, eq(messageFolders.messageId, messages.id))
    .innerJoin(folders, eq(folders.id, messageFolders.folderId))
    .where(
      and(
        eq(messages.accountId, accountId),
        isNull(messages.toAddresses),
        isNotNull(messageFolders.uid),
      ),
    )
    .groupBy(messages.id)
    .all()
    .filter((r): r is { messageId: string; folderPath: string; uid: number } => r.uid !== null);
}

/** Set a message's To/Cc (JSON-encoded EmailAddress[]). Used by the recipient backfill. */
export function setRecipientAddresses(
  messageId: string,
  toAddresses: string,
  ccAddresses: string,
): void {
  db.update(messages).set({ toAddresses, ccAddresses }).where(eq(messages.id, messageId)).run();
}

export function savePushSubscription(endpoint: string, p256dh: string, auth: string): void {
  db.insert(pushSubscriptions)
    .values({ endpoint, p256dh, auth })
    .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { p256dh, auth } })
    .run();
}

export function listPushSubscriptions(): (typeof pushSubscriptions.$inferSelect)[] {
  return db.select().from(pushSubscriptions).all();
}

export function deletePushSubscription(endpoint: string): void {
  db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)).run();
}
