/**
 * Read-side query helpers used by the HTTP API. Keeps route handlers thin and
 * keeps all SQL in one place. Local full-text search goes through the FTS5 index
 * (ARCHITECTURE §12 — never LIKE-scan).
 */
import { and, desc, eq, getTableColumns, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
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

/** Turn a user query into an FTS5 MATCH expression: prefix-match every term, AND-joined. */
function toFtsMatch(query: string): string {
  const terms = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  return terms.map((t) => `"${t}"*`).join(' ');
}

/** Local full-text search via FTS5, ranked. Returns hydrated message rows, best first. */
export function searchLocal(query: string, limit: number): MessageRow[] {
  const match = toFtsMatch(query);
  if (!match) return [];
  const rows = db.all(
    sql`SELECT message_id FROM messages_fts WHERE messages_fts MATCH ${match} ORDER BY rank LIMIT ${limit}`,
  ) as { message_id: string }[];
  const ids = rows.map((r) => r.message_id);
  if (ids.length === 0) return [];
  const byId = new Map(
    db
      .select()
      .from(messages)
      .where(and(inArray(messages.id, ids), isNull(messages.deletedAt)))
      .all()
      .map((m) => [m.id, m]),
  );
  // Preserve FTS rank order.
  return ids.map((id) => byId.get(id)).filter((m): m is MessageRow => Boolean(m));
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
