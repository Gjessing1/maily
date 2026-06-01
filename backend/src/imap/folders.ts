/**
 * Folder/label enumeration and role mapping. Folders are stored per account and
 * are many-to-many with messages (ARCHITECTURE §7) — this module only owns the
 * `folders` rows themselves.
 */
import type { ImapFlow } from 'imapflow';
import type { FolderRole } from '@maily/shared';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { folders } from '../db/schema.js';

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

/** Insert-or-update a folder row; refreshes name/role and the UIDVALIDITY guard. */
export function ensureFolder(
  accountId: string,
  path: string,
  name: string,
  role: FolderRole,
  uidValidity: number | null,
): FolderRow {
  const existing = db
    .select()
    .from(folders)
    .where(and(eq(folders.accountId, accountId), eq(folders.path, path)))
    .get();

  if (existing) {
    db.update(folders).set({ name, role, uidValidity }).where(eq(folders.id, existing.id)).run();
    return { ...existing, name, role, uidValidity };
  }

  return db.insert(folders).values({ accountId, path, name, role, uidValidity }).returning().get();
}

/** List the account's mailboxes from the server and reconcile them into `folders`. */
export async function syncFolders(client: ImapFlow, accountId: string): Promise<FolderRow[]> {
  const list = await client.list();
  const rows: FolderRow[] = [];
  for (const box of list) {
    // Skip \Noselect containers (pure hierarchy nodes hold no messages).
    if (box.flags.has('\\Noselect')) continue;
    const role = roleFromSpecialUse(box.specialUse, box.path);
    rows.push(ensureFolder(accountId, box.path, box.name, role, null));
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
  state: { uidValidity?: number; highestModseq?: number | null; lastUid?: number | null },
): void {
  db.update(folders).set(state).where(eq(folders.id, folderId)).run();
}
