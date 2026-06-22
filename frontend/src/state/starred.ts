/**
 * The virtual "Starred" view. Starring is the `\Flagged` IMAP flag, which is a
 * message-level property rather than a folder: Gmail surfaces it as a real
 * `[Gmail]/Starred` label, but mailbox.org and generic IMAP have no such folder. So
 * rather than depend on a provider-specific folder, we synthesise one per-account smart
 * folder backed by the flag, giving every account a consistent Starred view. The
 * backend's `listStarred` is the server-side source; the offline Dexie query mirrors it
 * by filtering the account's cached rows on `flagged`.
 */
import type { FolderDto } from '@maily/shared';

const PREFIX = 'starred:';

export const starredFolderId = (accountId: string): string => `${PREFIX}${accountId}`;
export const isStarredView = (id: string | undefined): id is string =>
  !!id && id.startsWith(PREFIX);
export const starredAccountId = (id: string): string => id.slice(PREFIX.length);

/** Synthetic folder entry presented in the drawer for the flag-derived Starred view. */
export function starredFolder(accountId: string): FolderDto {
  return { id: starredFolderId(accountId), accountId, path: '', name: 'Starred', role: 'custom' };
}
