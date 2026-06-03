/**
 * Folder/label enumeration and role mapping. Folders are stored per account and
 * are many-to-many with messages (ARCHITECTURE §7) — this module only owns the
 * `folders` rows themselves.
 */
import type { ImapFlow } from 'imapflow';
import type { FolderRole } from '@maily/shared';
import { and, eq, notInArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { folders } from '../db/schema.js';
import { createLogger } from '../logger.js';

const log = createLogger('folders');

export type FolderRow = typeof folders.$inferSelect;

/** Map an IMAP SPECIAL-USE flag (or the INBOX path) to our folder role. */
export function roleFromSpecialUse(specialUse: string | undefined, path: string): FolderRole {
  if (path.toUpperCase() === 'INBOX') return 'inbox';
  switch (specialUse) {
    case '\\Inbox':
      return 'inbox';
    case '\\Sent':
      return 'sent';
    case '\\Drafts':
      return 'drafts';
    case '\\Junk':
      return 'junk';
    case '\\Trash':
      return 'trash';
    case '\\Archive':
    case '\\All': // Gmail "All Mail" is our archive surface
      return 'archive';
    default:
      return 'custom';
  }
}

/**
 * Heuristic role from a folder's name, used only when the server omits SPECIAL-USE
 * (Gmail + mailbox.org both advertise it, so this is a safety net for generic IMAP).
 * Without it a missing `\Trash` flag would leave us with no trash folder and a
 * "delete" that tombstones locally but never moves the message server-side. Matches
 * are anchored to the full folder/basename so custom folders like "Trash 2019" are
 * not misclassified; covers the common English + German (mailbox.org) defaults.
 */
export function roleFromName(name: string, path: string): FolderRole {
  const basename = path.split(/[/.\\]/).pop() ?? '';
  const candidates = [name, basename].map((s) => s.trim().toLowerCase());
  const is = (re: RegExp): boolean => candidates.some((c) => re.test(c));
  if (is(/^(trash|bin|deleted( items| messages)?|papierkorb|gel[öo]schte( objekte| elemente)?)$/)) {
    return 'trash';
  }
  if (is(/^(sent( mail| items| messages)?|gesendet(e objekte)?)$/)) return 'sent';
  if (is(/^(drafts?|entw[üu]rfe)$/)) return 'drafts';
  if (is(/^(junk( e-?mail)?|spam|bulk mail)$/)) return 'junk';
  if (is(/^(archive|all mail|archiv)$/)) return 'archive';
  return 'custom';
}

/**
 * Insert-or-update a folder row from a LIST enumeration. Refreshes only the
 * display-facing fields (name/role); it MUST NOT touch the resync bookkeeping
 * (`uid_validity`, `last_uid`, `highest_modseq`), which is owned solely by
 * `updateFolderSyncState` after an actual sync pass. Clobbering `uid_validity`
 * here would make every reconnect/cron look like a UIDVALIDITY change and force
 * `resyncFolder` to wipe + rebuild every folder's mappings (stranding any message
 * outside the cache window as a live-but-unmapped orphan). The real UIDVALIDITY
 * is read fresh from the opened mailbox inside `resyncFolder`.
 */
export function ensureFolder(
  accountId: string,
  path: string,
  name: string,
  role: FolderRole,
): FolderRow {
  const existing = db
    .select()
    .from(folders)
    .where(and(eq(folders.accountId, accountId), eq(folders.path, path)))
    .get();

  if (existing) {
    db.update(folders).set({ name, role }).where(eq(folders.id, existing.id)).run();
    return { ...existing, name, role };
  }

  // New folder: uid_validity stays null so the first resync does a full sync.
  return db.insert(folders).values({ accountId, path, name, role }).returning().get();
}

/**
 * List the account's mailboxes from the server and reconcile them into `folders`.
 * Prunes rows for paths the server no longer advertises: when a Gmail account
 * switches UI language the special-folder IMAP paths are renamed
 * (`[Gmail]/Sendt e-post` → `[Gmail]/Sent Mail`), and without pruning the old
 * rows linger forever, showing duplicate folders in two languages. Deleting a
 * folder cascades its `message_folders` mappings; the messages themselves
 * survive and are re-mapped to the renamed folder on its next (full) resync.
 */
export async function syncFolders(client: ImapFlow, accountId: string): Promise<FolderRow[]> {
  const list = await client.list();
  const rows: FolderRow[] = [];
  const seenPaths: string[] = [];
  for (const box of list) {
    seenPaths.push(box.path);
    // Skip \Noselect containers (pure hierarchy nodes hold no messages).
    if (box.flags.has('\\Noselect')) continue;
    // SPECIAL-USE is authoritative; fall back to name matching only when absent.
    let role = roleFromSpecialUse(box.specialUse, box.path);
    if (role === 'custom') role = roleFromName(box.name, box.path);
    rows.push(ensureFolder(accountId, box.path, box.name, role));
  }

  // Prune folders the server no longer lists. Guarded by a non-empty enumeration
  // (every account exposes at least INBOX) so a transient empty LIST can't wipe
  // the table; an erroneous prune would only force a re-create + full resync.
  if (seenPaths.length > 0) {
    const removed = db
      .delete(folders)
      .where(and(eq(folders.accountId, accountId), notInArray(folders.path, seenPaths)))
      .returning()
      .all();
    for (const f of removed) {
      log.info(`pruned stale folder "${f.path}" (account ${accountId})`);
    }
  }

  return rows;
}

/** Reload a folder row by id (resync state is mutated in the DB between passes). */
export function getFolderById(id: string): FolderRow | undefined {
  return db.select().from(folders).where(eq(folders.id, id)).get();
}

/** Persist resync bookkeeping for a folder after a sync pass. */
export function updateFolderSyncState(
  folderId: string,
  state: {
    uidValidity?: number;
    highestModseq?: number | null;
    lastUid?: number | null;
    /** Low-watermark of the resumable full-source sweep (ROADMAP §3.7.E). */
    oldestSyncedUid?: number | null;
  },
): void {
  db.update(folders).set(state).where(eq(folders.id, folderId)).run();
}
