/**
 * The one answer to "is this message visible here?". Every read that lists, counts, searches or
 * enqueues messages filters through {@link visible} (Drizzle) or {@link visibleRaw} (raw SQL over
 * `messages m`) instead of spelling out the lifecycle columns itself.
 *
 * Two scopes, because Trash is the one place a tombstone is the expected content:
 * - `normal` — every view except Trash: tombstoned (`deleted_at`) mail is hidden. A delete or
 *   cleanup tombstones the row, so it drops out of the inbox the moment the user acts.
 * - `trash` — trash-role folders and `in:trash` search: the tombstone stays listable (a delete
 *   MOVEs the message to Trash; hiding it there would make the move look like a hard delete).
 *   Only purged shells (`purged_at`: heavy data reclaimed, identity kept so resync doesn't
 *   re-download it) are hidden.
 *
 * `normal` does not test `purged_at` because a purged shell is always tombstoned too: purge sets
 * both, and a re-sight never clears `deleted_at` on a purged row (store.ts `touchKnownMessage`).
 * Keeping `normal` to the one column matters for speed — `purged_at` was ALTER-TABLE-added, so it
 * sits after the body columns and reading it on every list row walks their overflow pages.
 */
import { eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { FolderRole } from '@maily/shared';
import { db } from './client.js';
import { folders, messages } from './schema.js';

export type VisibilityScope = 'normal' | 'trash';

/** Visibility predicate over the `messages` table, for Drizzle queries. */
export function visible(scope: VisibilityScope = 'normal'): SQL {
  return scope === 'trash' ? isNull(messages.purgedAt) : isNull(messages.deletedAt);
}

/** Visibility predicate for raw SQL that aliases `messages` as `m`. */
export function visibleRaw(scope: VisibilityScope = 'normal'): SQL {
  return scope === 'trash' ? sql`m.purged_at IS NULL` : sql`m.deleted_at IS NULL`;
}

/** The scope a view over folders of one role uses. */
export function scopeForRole(role: FolderRole | null | undefined): VisibilityScope {
  return role === 'trash' ? 'trash' : 'normal';
}

/** The scope a single folder's listing and count use. */
export function scopeForFolder(folderId: string): VisibilityScope {
  return scopeForRole(
    db.select({ role: folders.role }).from(folders).where(eq(folders.id, folderId)).get()?.role,
  );
}
