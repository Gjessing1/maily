/**
 * Mailbox intents — the local half of every server-facing mailbox mutation (delete, archive,
 * flags). Each one is an outbox row whose local effect is applied in the same transaction that
 * enqueues it, and whose payload records what that effect replaced. The runner applies the
 * inverse on undo (cancel) and when the server action goes `dead`, so the local mailbox always
 * converges back on what the provider still has instead of silently diverging from it.
 *
 * The apply/revert functions here run inside the caller's transaction and emit nothing; the
 * runner owns signals, because only it knows whether the change committed.
 */
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { messageFolders, messages, outbox } from '../db/schema.js';

export type FlagName = 'seen' | 'flagged';
export type FlagSet = Partial<Record<FlagName, boolean>>;

export interface DeletePayload {
  /** Already tombstoned before this delete — then the inverse must leave the tombstone. */
  wasDeleted: boolean;
}

export interface ArchivePayload {
  /** The inbox mapping the archive removed; null when the message wasn't in the inbox. */
  from: { folderId: string; uid: number | null } | null;
  /** The archive-role folder the message was mapped into. */
  destId: string;
  /** Whether that mapping is new — only then does the inverse remove it. */
  addedDest: boolean;
}

export interface FlagsPayload {
  /** The flags this intent sets. */
  set: FlagSet;
  /** The local value each of those flags had before — what the inverse restores. */
  prev: FlagSet;
}

const FLAG_NAMES: FlagName[] = ['seen', 'flagged'];

export function parsePayload<T>(payload: string | null): T | null {
  if (!payload) return null;
  try {
    return JSON.parse(payload) as T;
  } catch {
    return null;
  }
}

// ── delete ──────────────────────────────────────────────────────────────────

export function applyDelete(messageId: string): DeletePayload {
  const row = db
    .select({ deletedAt: messages.deletedAt })
    .from(messages)
    .where(eq(messages.id, messageId))
    .get();
  db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, messageId)).run();
  return { wasDeleted: row?.deletedAt != null };
}

/** Clear the tombstone this delete set. A pre-deploy row has no payload: it tombstoned too. */
export function revertDelete(messageId: string, p: DeletePayload | null): boolean {
  if (p?.wasDeleted) return false;
  db.update(messages).set({ deletedAt: null }).where(eq(messages.id, messageId)).run();
  return true;
}

// ── archive ─────────────────────────────────────────────────────────────────

/**
 * Take the message out of the inbox locally: drop the inbox mapping and map it into the archive
 * folder (UID unknown until the server MOVE reports it). Other labels are left alone. Without
 * this the server's read model kept listing an archived message in INBOX for the whole window.
 */
export function applyArchive(
  messageId: string,
  inboxId: string | undefined,
  archiveId: string,
): ArchivePayload {
  const from = inboxId
    ? db
        .select({ folderId: messageFolders.folderId, uid: messageFolders.uid })
        .from(messageFolders)
        .where(and(eq(messageFolders.messageId, messageId), eq(messageFolders.folderId, inboxId)))
        .get()
    : undefined;
  if (!from) return { from: null, destId: archiveId, addedDest: false };

  db.delete(messageFolders)
    .where(and(eq(messageFolders.messageId, messageId), eq(messageFolders.folderId, inboxId!)))
    .run();
  const added = db
    .insert(messageFolders)
    .values({ messageId, folderId: archiveId, uid: null })
    .onConflictDoNothing()
    .run();
  return { from, destId: archiveId, addedDest: added.changes === 1 };
}

/** Put the inbox mapping back and drop the archive mapping this intent created. */
export function revertArchive(messageId: string, p: ArchivePayload | null): boolean {
  if (!p?.from) return false;
  db.insert(messageFolders)
    .values({ messageId, folderId: p.from.folderId, uid: p.from.uid })
    .onConflictDoNothing()
    .run();
  if (p.addedDest) {
    // Only while it's still the placeholder — a sync that since found the real copy keeps it.
    db.delete(messageFolders)
      .where(
        and(
          eq(messageFolders.messageId, messageId),
          eq(messageFolders.folderId, p.destId),
          isNull(messageFolders.uid),
        ),
      )
      .run();
  }
  return true;
}

// ── flags ───────────────────────────────────────────────────────────────────

export function currentFlags(messageId: string): { seen: boolean; flagged: boolean } | undefined {
  return db
    .select({ seen: messages.seen, flagged: messages.flagged })
    .from(messages)
    .where(eq(messages.id, messageId))
    .get();
}

export function applyFlags(messageId: string, set: FlagSet): FlagsPayload {
  const cur = currentFlags(messageId);
  const prev: FlagSet = {};
  for (const f of FLAG_NAMES) if (set[f] !== undefined && cur) prev[f] = cur[f];
  db.update(messages).set(set).where(eq(messages.id, messageId)).run();
  return { set, prev };
}

/**
 * Undo a flags intent that never reached the server. Toggles can stack (read, then unread before
 * the first STORE lands), so for each flag:
 * - a newer intent for the same flag still in flight inherits this one's `prev` — the server
 *   never saw this value, so what that one replaces is really the older value;
 * - a newer intent that already landed owns the flag — leave it;
 * - otherwise restore `prev`, but only if the local value is still the one this intent set
 *   (a sync may since have brought the provider's own value).
 * Returns whether the local flags changed.
 */
export function revertFlags(rowId: string, messageId: string, p: FlagsPayload | null): boolean {
  if (!p) return false;
  const newer = db
    .select({ id: outbox.id, status: outbox.status, payload: outbox.payload })
    .from(outbox)
    .where(
      and(
        eq(outbox.messageId, messageId),
        eq(outbox.kind, 'flags'),
        inArray(outbox.status, ['pending', 'sending', 'done']),
        gt(sql`${outbox}.rowid`, sql`(SELECT rowid FROM outbox WHERE id = ${rowId})`),
      ),
    )
    .orderBy(sql`${outbox}.rowid`)
    .all();

  const restore: FlagSet = {};
  const cur = currentFlags(messageId);
  for (const f of FLAG_NAMES) {
    const target = p.set[f];
    const prev = p.prev[f];
    if (target === undefined || prev === undefined) continue;
    const next = newer.find((r) => parsePayload<FlagsPayload>(r.payload)?.set[f] !== undefined);
    if (next && next.status === 'done') continue;
    if (next) {
      const np = parsePayload<FlagsPayload>(next.payload)!;
      np.prev[f] = prev;
      db.update(outbox)
        .set({ payload: JSON.stringify(np) })
        .where(eq(outbox.id, next.id))
        .run();
      continue;
    }
    if (cur?.[f] === target && prev !== target) restore[f] = prev;
  }
  if (Object.keys(restore).length === 0) return false;
  db.update(messages).set(restore).where(eq(messages.id, messageId)).run();
  return true;
}
