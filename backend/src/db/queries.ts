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
  gte,
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

/**
 * Tombstoned messages (§13) are hidden everywhere EXCEPT trash-role folders: a delete/cleanup
 * tombstones the row and MOVEs it to Trash, so in Trash the tombstone IS the expected content —
 * hiding it there would make the move look like a hard delete (nothing ever "arrives" in Trash).
 */
function isTrashFolder(folderId: string): boolean {
  return (
    db.select({ role: folders.role }).from(folders).where(eq(folders.id, folderId)).get()?.role ===
    'trash'
  );
}

/** Count of messages currently mapped into a folder (cached count). Tombstones hidden (§13) except in trash. */
export function folderMessageCount(folderId: string): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(messageFolders)
    .innerJoin(messages, eq(messageFolders.messageId, messages.id))
    .where(
      and(
        eq(messageFolders.folderId, folderId),
        isTrashFolder(folderId) ? undefined : isNull(messages.deletedAt),
      ),
    )
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

/** Whether a message has been detached to local-only (no server copy; inert to sync). */
export function isMessageLocalOnly(id: string): boolean {
  return (
    db.select({ l: messages.localOnly }).from(messages).where(eq(messages.id, id)).get()?.l === true
  );
}

/** Messages in a folder, newest first, keyset-paginated by receivedAt. Tombstones hidden (§13) except in trash. */
export function listMessages(folderId: string, limit: number, beforeMs?: number): MessageRow[] {
  const where = and(
    eq(messageFolders.folderId, folderId),
    isTrashFolder(folderId) ? undefined : isNull(messages.deletedAt),
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
 * Every non-tombstoned message in one conversation, oldest-first — the input set for
 * the threaded conversation reader (ARCHITECTURE §11). Scoped by `accountId` because a
 * thread id (Gmail X-GM-THRID, or a `References`-derived hash) is only unique within an
 * account, never across them. Spans folders deliberately: a conversation includes its
 * Sent replies, not just the inbox copies. Chronological so the client can order it
 * either way without a second sort key.
 */
export function listThread(accountId: string, threadId: string): MessageRow[] {
  return db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.accountId, accountId),
        eq(messages.threadId, threadId),
        isNull(messages.deletedAt),
      ),
    )
    .orderBy(messages.receivedAt)
    .all();
}

/** Roles that have a meaningful cross-account merged view (e.g. "All inboxes"). */
export type UnifiedRole = 'inbox' | 'drafts' | 'sent' | 'junk' | 'trash';

/**
 * Virtual unified view: every account's folder of a given role merged into one
 * newest-first stream ("All inboxes", "All sent", …). Same keyset pagination as
 * `listMessages`; tombstones hidden (§13). A message lives in exactly one account's
 * folder per role, so no cross-account de-dup is needed.
 */
export function listUnifiedByRole(
  role: UnifiedRole,
  limit: number,
  beforeMs?: number,
): MessageRow[] {
  return db
    .select(getTableColumns(messages))
    .from(messages)
    .innerJoin(messageFolders, eq(messageFolders.messageId, messages.id))
    .innerJoin(folders, eq(folders.id, messageFolders.folderId))
    .where(
      and(
        eq(folders.role, role),
        // In the unified Trash, tombstones mapped into a trash folder are the content itself.
        role === 'trash' ? undefined : isNull(messages.deletedAt),
        beforeMs ? lt(messages.receivedAt, new Date(beforeMs)) : undefined,
      ),
    )
    .orderBy(desc(messages.receivedAt))
    .limit(limit)
    .all();
}

/** Back-compat alias for the unified inbox (the `/api/inbox` endpoint). */
export function listUnifiedInbox(limit: number, beforeMs?: number): MessageRow[] {
  return listUnifiedByRole('inbox', limit, beforeMs);
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

/**
 * Virtual "Starred" view: an account's `\Flagged` messages, newest first. Provider-
 * agnostic — Gmail exposes a `[Gmail]/Starred` folder but mailbox.org and generic IMAP
 * have none, so the view is derived from the message-level flag rather than a folder
 * (the frontend hides the real Gmail folder and uses this everywhere). Tombstones —
 * including trashed mail — are hidden; keyset-paginated by receivedAt.
 */
export function listStarred(accountId: string, limit: number, beforeMs?: number): MessageRow[] {
  return db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.accountId, accountId),
        eq(messages.flagged, true),
        isNull(messages.deletedAt),
        beforeMs ? lt(messages.receivedAt, new Date(beforeMs)) : undefined,
      ),
    )
    .orderBy(desc(messages.receivedAt))
    .limit(limit)
    .all();
}

/**
 * Estimated on-disk bytes of synced content for an account: the archived raw `.eml`
 * (`source_bytes` — the dominant true cost once the master-archive sweep has run,
 * ROADMAP §3.7.E) plus the parsed body columns (subject + snippet + text/html) plus
 * the bytes of attachments actually downloaded to disk. Lazy attachments never fetched
 * occupy no space (ARCHITECTURE §4), so the local figure is far smaller than the
 * mailbox's server-side total. For an archived message the body terms double-count a
 * small slice already inside the `.eml`, but `source_bytes` dominates — same trade-off
 * as the cleanup storage metric (slices.ts). `length(cast(… as blob))` yields byte
 * length rather than character count. The body text/html term reads the precomputed
 * `content_bytes` column (migration 0018) — length() over the bodies inside the
 * aggregate would read + decode every body on each Settings visit.
 */
export function accountContentBytes(accountId: string): number {
  const body = db
    .select({
      bytes: sql<number>`coalesce(sum(
        coalesce(${messages.sourceBytes}, 0) +
        length(cast(coalesce(${messages.subject}, '') as blob)) +
        length(cast(coalesce(${messages.snippet}, '') as blob)) +
        coalesce(${messages.contentBytes},
          length(cast(coalesce(${messages.bodyText}, '') as blob)) +
          length(cast(coalesce(${messages.bodyHtml}, '') as blob)))
      ), 0)`,
    })
    .from(messages)
    .where(and(eq(messages.accountId, accountId), isNull(messages.deletedAt)))
    .get();

  const atts = db
    .select({ bytes: sql<number>`coalesce(sum(${attachments.sizeBytes}), 0)` })
    .from(attachments)
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .where(and(eq(messages.accountId, accountId), isNotNull(attachments.downloadedAt)))
    .get();

  return (body?.bytes ?? 0) + (atts?.bytes ?? 0);
}

/** One detach candidate: a live, not-yet-detached message + the data the job needs. */
export interface DetachCandidate {
  id: string;
  sourcePath: string | null;
  sourceBytes: number | null;
  receivedAt: Date | null;
  subject: string | null;
}

/**
 * Messages eligible to be detached to local-only for an account: live (not tombstoned),
 * not already detached, optionally only those received before `beforeMs` (the cutoff
 * scope). Newest-first. The job partitions these into safe (local `.eml` present) vs
 * unsafe (no local source — never deleted from the server) before touching anything.
 */
export function listDetachCandidates(
  accountId: string,
  beforeMs?: number,
  afterMs?: number,
): DetachCandidate[] {
  return db
    .select({
      id: messages.id,
      sourcePath: messages.sourcePath,
      sourceBytes: messages.sourceBytes,
      receivedAt: messages.receivedAt,
      subject: messages.subject,
    })
    .from(messages)
    .where(
      and(
        eq(messages.accountId, accountId),
        isNull(messages.deletedAt),
        eq(messages.localOnly, false),
        beforeMs ? lt(messages.receivedAt, new Date(beforeMs)) : undefined,
        afterMs ? gte(messages.receivedAt, new Date(afterMs)) : undefined,
      ),
    )
    .orderBy(desc(messages.receivedAt))
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
