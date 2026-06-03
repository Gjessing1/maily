/**
 * Message persistence: identity dedup, many-to-many folder mapping, attachment
 * metadata, and back-fillable threading.
 *
 * Dedup (KEY GOTCHA): the primary key is an internal UUID. We dedup an incoming
 * message against existing rows by gm_msgid first (account-unique on Gmail), then
 * by message_id scoped to the account. A known id → update flags + folder mapping;
 * otherwise insert. The IMAP UID lives on message_folders, never as a global key.
 *
 * Threading (ARCHITECTURE §11): Gmail gives us X-GM-THRID directly. Otherwise we
 * derive a thread id from In-Reply-To / References, and we merge threads in both
 * arrival orders so out-of-order delivery is back-fillable.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { FolderRole } from '@maily/shared';
import { db } from '../db/client.js';
import { attachments, messageFolders, messages } from '../db/schema.js';
import type { MessageFlags, ParsedMessage } from './types.js';

export interface UpsertResult {
  id: string;
  inserted: boolean;
}

/** Split a raw References header into individual Message-IDs. */
function parseReferences(raw: string | null): string[] {
  if (!raw) return [];
  return raw.match(/<[^>]+>/g) ?? [];
}

/**
 * Find an existing message row for this account by the strongest available identity
 * (gm_msgid first, then account-scoped message_id). Takes the identity fields
 * directly — both are available from the IMAP envelope WITHOUT downloading the
 * body, so the sync engine can dedup before paying for a body fetch.
 */
export function findExistingId(
  accountId: string,
  gmMsgId: string | null,
  messageId: string | null,
): string | undefined {
  if (gmMsgId) {
    const byGm = db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.accountId, accountId), eq(messages.gmMsgId, gmMsgId)))
      .get();
    if (byGm) return byGm.id;
  }
  if (messageId) {
    return db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.accountId, accountId), eq(messages.messageId, messageId)))
      .get()?.id;
  }
  return undefined;
}

/**
 * Resolve the thread id for a new message (non-Gmail path). Inherits the thread of
 * any already-known ancestor referenced by In-Reply-To / References; otherwise opens
 * a fresh thread keyed by this message's own Message-ID (stable for later back-fill).
 */
function resolveThreadId(accountId: string, parsed: ParsedMessage): string {
  if (parsed.providerThreadId) return parsed.providerThreadId;

  const ancestors = [parsed.inReplyTo, ...parseReferences(parsed.references)].filter(
    (id): id is string => Boolean(id),
  );
  if (ancestors.length > 0) {
    const parent = db
      .select({ threadId: messages.threadId })
      .from(messages)
      .where(and(eq(messages.accountId, accountId), inArray(messages.messageId, ancestors)))
      .get();
    if (parent?.threadId) return parent.threadId;
  }
  return parsed.messageId ?? randomUUID();
}

/**
 * Back-fill: a newly-inserted message may be the parent of replies that arrived
 * first and opened their own thread. Re-point those orphaned threads onto this one.
 */
function mergeOrphanReplies(accountId: string, newId: string, parsed: ParsedMessage): void {
  if (!parsed.messageId) return;
  const ownThread = db
    .select({ threadId: messages.threadId })
    .from(messages)
    .where(eq(messages.id, newId))
    .get()?.threadId;
  if (!ownThread) return;

  // Direct replies point In-Reply-To at our Message-ID but landed in a different thread.
  const orphans = db
    .select({ threadId: messages.threadId })
    .from(messages)
    .where(
      and(
        eq(messages.accountId, accountId),
        eq(messages.inReplyTo, parsed.messageId),
        ne(messages.threadId, ownThread),
      ),
    )
    .all();

  const staleThreads = [...new Set(orphans.map((o) => o.threadId).filter(Boolean))] as string[];
  for (const stale of staleThreads) {
    db.update(messages)
      .set({ threadId: ownThread })
      .where(and(eq(messages.accountId, accountId), eq(messages.threadId, stale)))
      .run();
  }
}

/** Insert-or-update message<->folder mapping carrying the per-folder IMAP UID. */
function linkFolder(messageId: string, folderId: string, uid: number | null): void {
  db.insert(messageFolders)
    .values({ messageId, folderId, uid })
    .onConflictDoUpdate({
      target: [messageFolders.messageId, messageFolders.folderId],
      set: { uid },
    })
    .run();
}

/**
 * Update an already-known message from a re-sighting: refresh its flags and ensure
 * the folder mapping carries the current UID — WITHOUT re-parsing or re-downloading
 * the body (the body was stored on first insert). This is the hot path during a
 * full folder rebuild on Gmail, where most INBOX messages already exist via All Mail;
 * skipping the body fetch turns a multi-hour rebuild into a near-instant remap.
 */
export function touchKnownMessage(
  messageId: string,
  folderId: string,
  uid: number | null,
  flags: MessageFlags,
  folderRole: FolderRole,
): void {
  const set: Partial<typeof messages.$inferInsert> = {
    seen: flags.seen,
    flagged: flags.flagged,
    answered: flags.answered,
    draft: flags.draft,
  };
  // Re-sighting a message in a non-trash folder un-tombstones it: it clearly still
  // exists on the server (undelete, or a move-race that briefly orphaned it). A
  // re-sight in Trash must NOT clear the tombstone — trashed mail stays hidden from
  // every list/search view (ARCHITECTURE §13).
  if (folderRole !== 'trash') set.deletedAt = null;
  db.update(messages).set(set).where(eq(messages.id, messageId)).run();
  linkFolder(messageId, folderId, uid);
}

/** Persist a parsed message into the given folder. Idempotent per (identity, folder).
 *
 * `opts.id` lets the caller pre-assign the internal UUID — used by live full-source
 * capture, which must know the UUID to stream the `.eml` to its partitioned path
 * before the row exists. On a dedup hit nothing is inserted (the caller discards the
 * staged source file), so the pre-assigned id is harmless when unused. */
export function upsertMessage(
  accountId: string,
  folderId: string,
  uid: number | null,
  parsed: ParsedMessage,
  folderRole: FolderRole,
  opts?: { id?: string },
): UpsertResult {
  return db.transaction((): UpsertResult => {
    const existingId = findExistingId(accountId, parsed.gmMsgId, parsed.messageId);
    if (existingId) {
      touchKnownMessage(existingId, folderId, uid, parsed.flags, folderRole);
      return { id: existingId, inserted: false };
    }

    const threadId = resolveThreadId(accountId, parsed);
    const inserted = db
      .insert(messages)
      .values({
        ...(opts?.id ? { id: opts.id } : {}),
        accountId,
        messageId: parsed.messageId,
        gmMsgId: parsed.gmMsgId,
        threadId,
        inReplyTo: parsed.inReplyTo,
        references: parsed.references,
        subject: parsed.subject,
        fromName: parsed.fromName,
        fromAddress: parsed.fromAddress,
        toAddresses: parsed.to.length ? JSON.stringify(parsed.to) : null,
        ccAddresses: parsed.cc.length ? JSON.stringify(parsed.cc) : null,
        snippet: parsed.snippet,
        bodyText: parsed.bodyText,
        bodyHtml: parsed.bodyHtml,
        sourcePath: parsed.sourcePath,
        sentAt: parsed.sentAt,
        receivedAt: parsed.receivedAt,
        seen: parsed.flags.seen,
        flagged: parsed.flags.flagged,
        answered: parsed.flags.answered,
        draft: parsed.flags.draft,
      })
      .returning({ id: messages.id })
      .get();

    linkFolder(inserted.id, folderId, uid);

    for (const att of parsed.attachments) {
      db.insert(attachments)
        .values({
          messageId: inserted.id,
          filename: att.filename,
          mimeType: att.mimeType,
          sizeBytes: att.sizeBytes,
          imapPartId: att.imapPartId,
          partOrdinal: att.partOrdinal,
          contentId: att.contentId,
          isInline: att.isInline,
        })
        .run();
    }

    mergeOrphanReplies(accountId, inserted.id, parsed);
    return { id: inserted.id, inserted: true };
  });
}

/** Soft-delete: set the tombstone timestamp. Row + metadata survive (ARCHITECTURE §13). */
export function markMessageDeleted(messageId: string): void {
  db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, messageId)).run();
}

/**
 * Replace ALL of a message's folder mappings with a single mapping into `folderId`.
 * Used after an interactive MOVE-to-Trash: on Gmail the server strips every other
 * label, on generic IMAP the one source folder is vacated — either way the local
 * mapping converges to just the destination. Keeping one `(folder, uid)` mapping
 * leaves the message's attachments fetchable via `uidLocationForMessage`.
 */
export function relinkMessageToFolder(
  messageId: string,
  folderId: string,
  uid: number | null,
): void {
  db.transaction(() => {
    db.delete(messageFolders).where(eq(messageFolders.messageId, messageId)).run();
    db.insert(messageFolders).values({ messageId, folderId, uid }).run();
  });
}

/** Update just the IMAP flags for a message (resync / IDLE flag events). */
export function updateMessageFlags(
  messageId: string,
  flags: { seen: boolean; flagged: boolean; answered: boolean; draft: boolean },
): void {
  db.update(messages).set(flags).where(eq(messages.id, messageId)).run();
}

/** Look up the internal message id owning a given UID in a folder (for flag/expunge events). */
export function messageIdForUid(folderId: string, uid: number): string | undefined {
  return db
    .select({ id: messageFolders.messageId })
    .from(messageFolders)
    .where(and(eq(messageFolders.folderId, folderId), eq(messageFolders.uid, uid)))
    .get()?.id;
}

/** All UIDs currently mapped into a folder — used for expunge reconciliation. */
export function knownUids(folderId: string): number[] {
  return db
    .select({ uid: messageFolders.uid })
    .from(messageFolders)
    .where(eq(messageFolders.folderId, folderId))
    .all()
    .map((r) => r.uid)
    .filter((u): u is number => u !== null);
}

/**
 * Drop folder mappings for the given UIDs (messages expunged from that folder) and
 * converge any now fully-orphaned message onto the tombstone model (ARCHITECTURE
 * §13): a message that no longer lives in ANY folder was permanently removed
 * server-side, so we mark `deleted_at` rather than leaving a dangling row. The row
 * itself is always kept so `/m/:internalUUID` deep links never 404. A later
 * re-sight in a non-trash folder (`upsertMessage`) clears the tombstone, so a
 * cross-folder move that momentarily orphans a message self-heals.
 */
export function unlinkUids(folderId: string, uids: number[]): void {
  if (uids.length === 0) return;
  db.transaction(() => {
    const affected = db
      .select({ id: messageFolders.messageId })
      .from(messageFolders)
      .where(and(eq(messageFolders.folderId, folderId), inArray(messageFolders.uid, uids)))
      .all()
      .map((r) => r.id);

    db.delete(messageFolders)
      .where(and(eq(messageFolders.folderId, folderId), inArray(messageFolders.uid, uids)))
      .run();

    for (const id of affected) {
      const stillMapped = db
        .select({ folderId: messageFolders.folderId })
        .from(messageFolders)
        .where(eq(messageFolders.messageId, id))
        .limit(1)
        .get();
      if (!stillMapped) markMessageDeleted(id);
    }
  });
}

/** Drop ALL UID mappings for a folder — used when UIDVALIDITY changes (UIDs invalidated). */
export function clearFolderUids(folderId: string): void {
  db.delete(messageFolders).where(eq(messageFolders.folderId, folderId)).run();
}
