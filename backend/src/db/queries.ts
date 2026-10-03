/**
 * Read-side query helpers used by the HTTP API. Keeps route handlers thin and
 * keeps all SQL in one place. Local full-text search goes through the FTS5 index
 * (ARCHITECTURE §12 — never LIKE-scan).
 */
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  notExists,
  notInArray,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { db } from './client.js';
import { scopeForFolder, scopeForRole, visible } from './visibility.js';
import {
  accounts,
  attachments,
  pushDevices,
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

/** Count of visible messages mapped into a folder (cached count). */
export function folderMessageCount(folderId: string): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(messageFolders)
    .innerJoin(messages, eq(messageFolders.messageId, messages.id))
    .where(and(eq(messageFolders.folderId, folderId), visible(scopeForFolder(folderId))))
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

/**
 * The folder a role move (Report spam / Not spam) takes a message out of: its inbox copy when
 * it has one, else its other durable home — a role folder before a custom label. Trash and the
 * destination never count: trashed mail is restored, not moved.
 */
export function moveSourceFolder(
  messageId: string,
  destRole: (typeof folders.$inferSelect)['role'],
): { id: string; role: (typeof folders.$inferSelect)['role'] } | undefined {
  return db
    .select({ id: folders.id, role: folders.role })
    .from(messageFolders)
    .innerJoin(folders, eq(folders.id, messageFolders.folderId))
    .where(
      and(eq(messageFolders.messageId, messageId), notInArray(folders.role, ['trash', destRole])),
    )
    .orderBy(
      sql`CASE ${folders.role} WHEN 'inbox' THEN 0 WHEN 'custom' THEN 2 ELSE 1 END`,
      folders.path,
    )
    .get();
}

export function getMessage(id: string): MessageRow | undefined {
  return db.select().from(messages).where(eq(messages.id, id)).get();
}

/**
 * Unread-only filter for the list queries (`?unread=1`). MUST stay a literal `= 0`, not a
 * bound parameter: the `messages_unseen_received_idx` partial index (migration 0024) only
 * matches when SQLite can prove the predicate at compile time, and `seen = ?` can't.
 */
const unseen = sql`${messages.seen} = 0`;

/**
 * One newest-first page of full rows. The ids are picked first by an inner query that reads
 * `messages` only through its list covering index (migration 0033); only the page's own rows are
 * then fetched from the table. Sorting full rows directly reads every candidate's `received_at`,
 * which sits after the bodies in each record — ~300 ms for the 17k-row Gmail Trash on the N150.
 *
 * Every `messages` column that `where` / `joins` read MUST be in that index, or SQLite falls back
 * to the table and walks the body overflow pages the index exists to skip. The index is named
 * with INDEXED BY because the planner otherwise prefers the unique PK index for the join's
 * `id = ?` lookup; raw SQL because Drizzle's builder has no index hints for SQLite.
 */
function listPage(where: SQL | undefined, limit: number, joins: SQL = sql``): MessageRow[] {
  const ids = sql`SELECT ${messages.id} FROM ${messages} INDEXED BY messages_list_cover_idx
    ${joins} WHERE ${where ?? sql`1`} ORDER BY ${messages.receivedAt} DESC LIMIT ${limit}`;
  return db
    .select()
    .from(messages)
    .where(sql`${messages.id} IN (${ids})`)
    .orderBy(desc(messages.receivedAt))
    .all();
}

/** Joins a list query's `messages` to its folder mappings and their folders. */
const folderJoins = sql`INNER JOIN ${messageFolders} ON ${eq(messageFolders.messageId, messages.id)}
  INNER JOIN ${folders} ON ${eq(folders.id, messageFolders.folderId)}`;

/** Visible messages in a folder, newest first, keyset-paginated by receivedAt. */
export function listMessages(
  folderId: string,
  limit: number,
  beforeMs?: number,
  unseenOnly = false,
): MessageRow[] {
  const where = and(
    eq(messageFolders.folderId, folderId),
    visible(scopeForFolder(folderId)),
    beforeMs ? lt(messages.receivedAt, new Date(beforeMs)) : undefined,
    unseenOnly ? unseen : undefined,
  );
  return listPage(
    where,
    limit,
    sql`INNER JOIN ${messageFolders} ON ${eq(messageFolders.messageId, messages.id)}`,
  );
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
    .where(and(eq(messages.accountId, accountId), eq(messages.threadId, threadId), visible()))
    .orderBy(messages.receivedAt)
    .all();
}

/** Roles that have a meaningful cross-account merged view (e.g. "All inboxes"). */
export type UnifiedRole = 'inbox' | 'drafts' | 'sent' | 'junk' | 'trash';

/**
 * Virtual unified view: every account's folder of a given role merged into one
 * newest-first stream ("All inboxes", "All sent", …). Same keyset pagination as
 * `listMessages`; visibility follows the role (Trash shows its tombstones). A message lives in exactly one account's
 * folder per role, so no cross-account de-dup is needed.
 */
export function listUnifiedByRole(
  role: UnifiedRole,
  limit: number,
  beforeMs?: number,
  unseenOnly = false,
): MessageRow[] {
  return listPage(
    and(
      eq(folders.role, role),
      visible(scopeForRole(role)),
      beforeMs ? lt(messages.receivedAt, new Date(beforeMs)) : undefined,
      unseenOnly ? unseen : undefined,
    ),
    limit,
    folderJoins,
  );
}

/** Back-compat alias for the unified inbox (the `/api/inbox` endpoint). */
export function listUnifiedInbox(
  limit: number,
  beforeMs?: number,
  unseenOnly = false,
): MessageRow[] {
  return listUnifiedByRole('inbox', limit, beforeMs, unseenOnly);
}

/** Roles whose presence disqualifies a message from the virtual "Archived" view. */
const NON_ARCHIVE_ROLES = ['inbox', 'sent', 'trash', 'junk', 'drafts'] as const;

/**
 * Virtual "Archived" view: messages in the account's archive-role folder that are
 * NOT also in the inbox/sent/trash/junk/drafts. Gmail conflates archive with "All
 * Mail" (everything), so this subtraction is what makes "Archived" mean archived;
 * on providers with a real Archive folder the subtraction is a harmless no-op.
 * Tombstones hidden (ARCHITECTURE §13); newest first, keyset-paginated by receivedAt.
 */
export function listArchived(
  accountId: string,
  limit: number,
  beforeMs?: number,
  unseenOnly = false,
): MessageRow[] {
  const mf2 = alias(messageFolders, 'mf2');
  const f2 = alias(folders, 'f2');
  return listPage(
    and(
      eq(messages.accountId, accountId),
      eq(folders.role, 'archive'),
      visible(),
      beforeMs ? lt(messages.receivedAt, new Date(beforeMs)) : undefined,
      unseenOnly ? unseen : undefined,
      notExists(
        db
          .select({ one: sql`1` })
          .from(mf2)
          .innerJoin(f2, eq(f2.id, mf2.folderId))
          .where(and(eq(mf2.messageId, messages.id), inArray(f2.role, [...NON_ARCHIVE_ROLES]))),
      ),
    ),
    limit,
    folderJoins,
  );
}

/**
 * Virtual "Starred" view: an account's `\Flagged` messages, newest first. Provider-
 * agnostic — Gmail exposes a `[Gmail]/Starred` folder but mailbox.org and generic IMAP
 * have none, so the view is derived from the message-level flag rather than a folder
 * (the frontend hides the real Gmail folder and uses this everywhere). Tombstones —
 * including trashed mail — are hidden; keyset-paginated by receivedAt.
 */
export function listStarred(
  accountId: string,
  limit: number,
  beforeMs?: number,
  unseenOnly = false,
): MessageRow[] {
  return listPage(
    and(
      eq(messages.accountId, accountId),
      eq(messages.flagged, true),
      visible(),
      beforeMs ? lt(messages.receivedAt, new Date(beforeMs)) : undefined,
      unseenOnly ? unseen : undefined,
    ),
    limit,
  );
}

/**
 * Estimated on-disk bytes of synced content for an account. When the message is archived
 * the raw `.eml` (`source_bytes`, ARCHITECTURE §4) is AUTHORITATIVE — it already contains
 * the body and attachments, so it is the whole content cost and the parsed-body terms must
 * NOT be added on top (that double-counted the body for every archived message). Only a
 * not-yet-archived message (null/0 `source_bytes`) falls back to the parsed body columns
 * (subject + snippet + text/html). Added separately: attachments actually downloaded to
 * disk — those are genuine standalone files under `attachments/`, distinct from the copy
 * inside the `.eml`. Lazy attachments never fetched occupy no extra space (ARCHITECTURE
 * §4), so the local figure is far smaller than the mailbox's server-side total. This
 * mirrors the cleanup storage metric (slices.ts). `length(cast(… as blob))` yields byte
 * length rather than character count. The body text/html term reads the precomputed
 * `content_bytes` column (migration 0018) — length() over the bodies inside the
 * aggregate would read + decode every body on each Settings visit.
 *
 * Memoized with a short TTL: even on the fast path the scan must skip past the inline
 * body columns of every row (`source_bytes`/`content_bytes` were ALTER-TABLE-added, so
 * they sit after `body_text`/`body_html` in each record) — ~115 ms of synchronous
 * event-loop blocking per account on the N150. Settings polls /api/sync/status every
 * 5 s, and inbox fetches queue behind each poll; a display metric this slow-moving
 * doesn't need recomputing more than once a minute.
 */
const contentBytesMemo = new Map<string, { at: number; bytes: number }>();
const CONTENT_BYTES_TTL_MS = 60_000;

export function accountContentBytes(accountId: string): number {
  const hit = contentBytesMemo.get(accountId);
  if (hit && Date.now() - hit.at < CONTENT_BYTES_TTL_MS) return hit.bytes;
  const bytes = computeAccountContentBytes(accountId);
  contentBytesMemo.set(accountId, { at: Date.now(), bytes });
  return bytes;
}

function computeAccountContentBytes(accountId: string): number {
  const body = db
    .select({
      bytes: sql<number>`coalesce(sum(
        coalesce(nullif(${messages.sourceBytes}, 0),
          length(cast(coalesce(${messages.subject}, '') as blob)) +
          length(cast(coalesce(${messages.snippet}, '') as blob)) +
          coalesce(${messages.contentBytes},
            length(cast(coalesce(${messages.bodyText}, '') as blob)) +
            length(cast(coalesce(${messages.bodyHtml}, '') as blob))))
      ), 0)`,
    })
    .from(messages)
    .where(and(eq(messages.accountId, accountId), visible()))
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
        visible(),
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

/** Folder ids for a bounded message page in batched queries (one query per 500 ids). */
export function folderIdsForMessages(messageIds: string[]): Map<string, string[]> {
  const ids = [...new Set(messageIds)];
  const result = new Map(ids.map((id) => [id, [] as string[]]));
  for (let offset = 0; offset < ids.length; offset += 500) {
    const chunk = ids.slice(offset, offset + 500);
    if (chunk.length === 0) continue;
    const rows = db
      .select({ messageId: messageFolders.messageId, folderId: messageFolders.folderId })
      .from(messageFolders)
      .where(inArray(messageFolders.messageId, chunk))
      .all();
    for (const row of rows) result.get(row.messageId)?.push(row.folderId);
  }
  return result;
}

export function attachmentsForMessage(messageId: string): AttachmentRow[] {
  return db.select().from(attachments).where(eq(attachments.messageId, messageId)).all();
}

/** Attachment rows for a bounded message page in batched queries (one query per 500 ids). */
export function attachmentsForMessages(messageIds: string[]): Map<string, AttachmentRow[]> {
  const ids = [...new Set(messageIds)];
  const result = new Map(ids.map((id) => [id, [] as AttachmentRow[]]));
  for (let offset = 0; offset < ids.length; offset += 500) {
    const chunk = ids.slice(offset, offset + 500);
    if (chunk.length === 0) continue;
    const rows = db.select().from(attachments).where(inArray(attachments.messageId, chunk)).all();
    for (const row of rows) result.get(row.messageId)?.push(row);
  }
  return result;
}

export function getAttachment(id: string): AttachmentRow | undefined {
  return db.select().from(attachments).where(eq(attachments.id, id)).get();
}

/**
 * Every archived message (id + on-disk `.eml` path), oldest first — the input set for
 * the offline rebuild (ARCHITECTURE §4). Un-swept history (null `source_path`) is
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

/** The owning account of a message — used to build its partitioned on-disk path (ARCHITECTURE §4). */
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

export type PushDeviceRow = typeof pushDevices.$inferSelect;

/**
 * Register a device for self-hosted push. Keyed on the hash rather than the secret,
 * which the server does not keep — re-registering the same secret (the APK re-presents
 * the one it stored) is therefore an upsert that only bumps `lastSeenAt`.
 *
 * A new row starts with its catch-up cursor at *now*, not at zero. Turning notifications
 * on is not a request to be told about the mail already sitting in the inbox — without
 * this, the first connect would replay up to a day of it into the shade at once.
 */
export function savePushDevice(tokenHash: string, platform: string): void {
  const now = Date.now();
  db.insert(pushDevices)
    .values({ tokenHash, platform, lastSeenAt: now, lastEventAt: now })
    .onConflictDoUpdate({
      target: pushDevices.tokenHash,
      set: { platform, lastSeenAt: now },
    })
    .run();
}

/** The device a presented bearer secret belongs to, or undefined when it is unknown. */
export function pushDeviceByHash(tokenHash: string): PushDeviceRow | undefined {
  return db.select().from(pushDevices).where(eq(pushDevices.tokenHash, tokenHash)).get();
}

/** Mark a device connected — liveness, separate from the catch-up cursor. */
export function touchPushDevice(id: string): void {
  db.update(pushDevices).set({ lastSeenAt: Date.now() }).where(eq(pushDevices.id, id)).run();
}

/**
 * Advance the catch-up cursor past an arrival this device has now been told about, so a
 * later reconnect does not replay it. Monotonic: a replay walks the cursor forward one
 * message at a time, and an out-of-order write must never drag it back.
 */
export function advancePushDeviceCursor(id: string, at: number): void {
  db.update(pushDevices)
    .set({ lastEventAt: at })
    .where(and(eq(pushDevices.id, id), lt(sql`coalesce(${pushDevices.lastEventAt}, 0)`, at)))
    .run();
}

export function deletePushDevice(tokenHash: string): void {
  db.delete(pushDevices).where(eq(pushDevices.tokenHash, tokenHash)).run();
}
