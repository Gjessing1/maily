/**
 * The virtual "Archived" view. Gmail conflates archiving with the "All Mail"
 * label (which holds *everything*), so there is no real archive folder to open;
 * we synthesise a per-account smart folder = archive-role folder minus
 * inbox/sent/trash/junk/drafts. The backend's `listArchived` applies the same
 * subtraction server-side; this keeps the offline Dexie query in lockstep.
 */
import type { FolderDto, FolderRole } from '@maily/shared';

const PREFIX = 'archived:';

export const archivedFolderId = (accountId: string): string => `${PREFIX}${accountId}`;
export const isArchivedView = (id: string | undefined): id is string =>
  !!id && id.startsWith(PREFIX);
export const archivedAccountId = (id: string): string => id.slice(PREFIX.length);

/** Roles whose presence disqualifies a message from the Archived view (mirror of backend). */
export const NON_ARCHIVE_ROLES: ReadonlySet<FolderRole> = new Set<FolderRole>([
  'inbox',
  'sent',
  'trash',
  'junk',
  'drafts',
]);

/** Synthetic folder entry presented in the drawer in place of the raw archive folder. */
export function archivedFolder(accountId: string): FolderDto {
  return { id: archivedFolderId(accountId), accountId, path: '', name: 'Archive', role: 'archive' };
}
