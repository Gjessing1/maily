/**
 * The one answer to "where does this message live on the server?". Every executor that touches
 * the provider copy (flag STORE, MOVE, EXPUNGE, attachment fetch) asks {@link serverPlacement}
 * and switches on its `kind`, so TypeScript makes it handle detached mail.
 *
 * A detached (`local_only`) message still has folder mappings — it keeps showing where it was —
 * and those mappings still carry the UID it had before detach. That UID is stale: the server copy
 * is gone. Reading it straight off `message_folders` is how a STORE or MOVE ends up aimed at a
 * message the server no longer has, so the placement reports `local-only` before any UID.
 */
import { and, eq, exists, isNotNull, sql, type SQL } from 'drizzle-orm';
import { db } from './client.js';
import { folders, messageFolders, messages } from './schema.js';

export type ServerPlacement =
  /** A live server copy at this mailbox + UID. */
  | { kind: 'server'; accountId: string; folderPath: string; uid: number }
  /** Detached: this server is the message's only home. Any local change is the whole action. */
  | { kind: 'local-only' }
  /** No UID-bearing mapping (in the requested folder) — nothing on the server to act on. */
  | { kind: 'unplaced' };

/** Whether a message has been detached to local-only (no server copy; inert to sync). */
export function isMessageLocalOnly(messageId: string): boolean {
  return (
    db.select({ l: messages.localOnly }).from(messages).where(eq(messages.id, messageId)).get()
      ?.l === true
  );
}

/**
 * Role-bearing mailboxes (the ones a message durably lives in) outrank `custom` ones when a
 * message is mapped into several (ARCHITECTURE §7). Gmail's `[Gmail]/Starred` and
 * `[Gmail]/Important` are virtual views whose UIDs go stale the moment the label is cleared, and
 * an unordered pick was choosing exactly those — so attachment fetches came back empty.
 *
 * Deliberately no ordering *among* role-bearing folders: restore-from-Trash MOVEs out of the
 * mapping the message actually has, and ranking one role over another would retarget it.
 */
const ROLE_RANK = sql`CASE WHEN ${folders.role} = 'custom' THEN 1 ELSE 0 END`;

/**
 * Where a message lives on the server. With `folderId`, only a copy in that folder counts (for
 * moves out of a specific mailbox, e.g. archive from the inbox); a detached message is
 * `local-only` whichever folder is asked about.
 */
export function serverPlacement(messageId: string, folderId?: string): ServerPlacement {
  if (isMessageLocalOnly(messageId)) return { kind: 'local-only' };
  const row = db
    .select({ accountId: messages.accountId, folderPath: folders.path, uid: messageFolders.uid })
    .from(messageFolders)
    .innerJoin(folders, eq(folders.id, messageFolders.folderId))
    .innerJoin(messages, eq(messages.id, messageFolders.messageId))
    .where(
      and(
        eq(messageFolders.messageId, messageId),
        folderId ? eq(messageFolders.folderId, folderId) : undefined,
        isNotNull(messageFolders.uid),
      ),
    )
    // Tie-break on path so the pick is stable across runs rather than storage-order dependent.
    .orderBy(ROLE_RANK, folders.path)
    .get();
  return row && row.uid !== null ? { kind: 'server', ...row, uid: row.uid } : { kind: 'unplaced' };
}

/**
 * Predicate over `message_folders` rows: the mapping tracks a live server UID, i.e. it does not
 * belong to a detached message. Expunge and UIDVALIDITY reconciliation act only on these — a
 * detached mapping is frozen, and its stale UID is absent from every live UID set, so treating it
 * as tracked would report (and try to unlink) it as expunged on every pass.
 */
export const trackedMapping: SQL = exists(
  db
    .select({ one: sql`1` })
    .from(messages)
    .where(and(eq(messages.id, messageFolders.messageId), eq(messages.localOnly, false))),
);
