/**
 * The virtual "Unified Inbox" view — every account's inbox-role folder merged into
 * one newest-first stream. Like the Archived view it has no real folder row: the
 * backend's `/api/inbox` aggregates server-side and the offline Dexie query mirrors
 * it by unioning the messages of all inbox folders.
 */
import type { FolderDto } from '@maily/shared';

export const UNIFIED_INBOX_ID = 'unified:inbox';

export const isUnifiedView = (id: string | undefined): id is string => id === UNIFIED_INBOX_ID;

/** Synthetic folder entry for the drawer; not tied to any single account. */
export const unifiedFolder: FolderDto = {
  id: UNIFIED_INBOX_ID,
  accountId: '',
  path: '',
  name: 'All inboxes',
  role: 'inbox',
};
