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
import { db } from '../db/client.js';
import { attachments, messageFolders, messages } from '../db/schema.js';
import type { ParsedMessage } from './types.js';

export interface UpsertResult {
  id: string;
  inserted: boolean;
}

/** Split a raw References header into individual Message-IDs. */
function parseReferences(raw: string | null): string[] {
  if (!raw) return [];
  return raw.match(/<[^>]+>/g) ?? [];
}

/** Find an existing message row for this account by the strongest available identity. */
function findExisting(accountId: string, parsed: ParsedMessage): { id: string } | undefined {
  if (parsed.gmMsgId) {
    const byGm = db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.accountId, accountId), eq(messages.gmMsgId, parsed.gmMsgId)))
      .get();
    if (byGm) return byGm;
  }
  if (parsed.messageId) {
    return db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.accountId, accountId), eq(messages.messageId, parsed.messageId)))
      .get();
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

/** Persist a parsed message into the given folder. Idempotent per (identity, folder). */
export function upsertMessage(
  accountId: string,
  folderId: string,
  uid: number | null,
  parsed: ParsedMessage,
): UpsertResult {
  return db.transaction((): UpsertResult => {
    const existing = findExisting(accountId, parsed);
    if (existing) {
      db.update(messages)
        .set({
          seen: parsed.flags.seen,
          flagged: parsed.flags.flagged,
          answered: parsed.flags.answered,
          draft: parsed.flags.draft,
        })
        .where(eq(messages.id, existing.id))
        .run();
      linkFolder(existing.id, folderId, uid);
      return { id: existing.id, inserted: false };
    }

    const threadId = resolveThreadId(accountId, parsed);
    const inserted = db
      .insert(messages)
      .values({
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
          contentId: att.contentId,
          isInline: att.isInline,
        })
        .run();
    }

    mergeOrphanReplies(accountId, inserted.id, parsed);
    return { id: inserted.id, inserted: true };
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
 * Drop folder mappings for the given UIDs (messages expunged from that folder).
 * The message row itself is left intact — it may still live in other folders;
 * a generic cleanup of fully-orphaned messages can come later.
 */
export function unlinkUids(folderId: string, uids: number[]): void {
  if (uids.length === 0) return;
  db.delete(messageFolders)
    .where(and(eq(messageFolders.folderId, folderId), inArray(messageFolders.uid, uids)))
    .run();
}

/** Drop ALL UID mappings for a folder — used when UIDVALIDITY changes (UIDs invalidated). */
export function clearFolderUids(folderId: string): void {
  db.delete(messageFolders).where(eq(messageFolders.folderId, folderId)).run();
}
