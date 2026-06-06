/**
 * Virtual cross-account "unified" views — every account's folder of a given role
 * merged into one newest-first stream ("All inboxes", "All drafts", "All sent", …).
 * Like the Archived view these have no real folder row: the backend aggregates
 * server-side (`/api/inbox`, `/api/unified/:role`) and the offline Dexie query mirrors
 * it by unioning the messages of every folder with that role.
 */
import type { FolderDto, FolderRole } from '@maily/shared';

/** Roles that have a meaningful merged view across accounts. */
export type UnifiedRole = 'inbox' | 'drafts' | 'sent' | 'junk' | 'trash';

const PREFIX = 'unified:';

/** Virtual folder id for a unified view, e.g. `unified:inbox`. */
export const unifiedViewId = (role: UnifiedRole): string => `${PREFIX}${role}`;

/** Back-compat: the unified inbox id (the default multi-account landing view). */
export const UNIFIED_INBOX_ID = unifiedViewId('inbox');

export const isUnifiedView = (id: string | undefined): id is string =>
  !!id && id.startsWith(PREFIX);

/** The role behind a unified view id, or undefined if it isn't one. */
export const unifiedRole = (id: string | undefined): UnifiedRole | undefined =>
  isUnifiedView(id) ? (id.slice(PREFIX.length) as UnifiedRole) : undefined;

/** Drawer row labels (short) vs the list-header title (descriptive). */
const ROW_LABEL: Record<UnifiedRole, string> = {
  inbox: 'Inbox',
  drafts: 'Drafts',
  sent: 'Sent',
  junk: 'Spam',
  trash: 'Trash',
};
const VIEW_TITLE: Record<UnifiedRole, string> = {
  inbox: 'All inboxes',
  drafts: 'All drafts',
  sent: 'All sent',
  junk: 'All spam',
  trash: 'All trash',
};

/** Descriptive title for the list header (e.g. "All sent"). */
export const unifiedTitle = (id: string | undefined): string => {
  const role = unifiedRole(id);
  return role ? VIEW_TITLE[role] : 'All inboxes';
};

/** Synthetic folder entry for the drawer; not tied to any single account. */
export const unifiedFolderFor = (role: UnifiedRole): FolderDto => ({
  id: unifiedViewId(role),
  accountId: '',
  path: '',
  name: ROW_LABEL[role],
  role: role as FolderRole,
});

/** Back-compat: the unified inbox synthetic folder. */
export const unifiedFolder = unifiedFolderFor('inbox');
