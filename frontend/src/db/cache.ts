/**
 * Dexie / IndexedDB cache. Per ARCHITECTURE §6 this is a VOLATILE ~30-day cache,
 * NOT durable storage — iOS evicts it without warning. The backend SQLite is the
 * source of truth; every read falls back to the network and a cold/empty cache is
 * expected. We store list DTOs and (separately) full bodies so list views stay light.
 */
import Dexie, { type EntityTable } from 'dexie';
import type { AccountDto, FolderDto, MessageDetailDto, MessageDto, UploadDto } from '@maily/shared';
import { getPrefs } from '../state/prefs';

/** Cached list-view message: the DTO plus bookkeeping for eviction. */
export interface CachedMessage extends MessageDto {
  cachedAt: number;
}

/** Cached full message body, kept apart from the light list rows. */
export interface CachedBody extends MessageDetailDto {
  cachedAt: number;
}

interface MetaRow {
  key: string;
  value: unknown;
}

/**
 * A locally-persisted compose draft (ROADMAP §3.7.B). Local-first so an in-progress
 * message survives reload/refresh; the backend SQLite is unaware of it. Optional
 * IMAP APPEND to \Drafts is deferred.
 */
export interface DraftRecord {
  id: string;
  accountId?: string;
  to: string;
  cc: string;
  showCc: boolean;
  subject: string;
  bodyHtml: string;
  inReplyTo: string | null;
  references: string | null;
  attachments: { messageId: string; attachmentId: string; filename: string | null }[];
  uploads: UploadDto[];
  updatedAt: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function receivedMs(m: { receivedAt: string | null }): number {
  return m.receivedAt ? Date.parse(m.receivedAt) : 0;
}

/**
 * Recently-removed message ids ("removal tombstones"). Closes a race: a body
 * prefetch or list fetch can be in flight when a `mail:deleted`/`mail:archived`
 * signal removes the message — the late response would silently re-insert the
 * ghost row. Cache writes skip ids removed within this window; an explicit
 * restore (undo, `mail:restored`) clears the tombstone first.
 */
const REMOVAL_TOMBSTONE_MS = 60_000;
const removedRecently = new Map<string, number>();

function isTombstoned(id: string): boolean {
  const at = removedRecently.get(id);
  if (at === undefined) return false;
  if (Date.now() - at > REMOVAL_TOMBSTONE_MS) {
    removedRecently.delete(id);
    return false;
  }
  return true;
}

/** Allow a removed message to be cached again (undo / server-side restore). */
export function clearRemovalTombstone(id: string): void {
  removedRecently.delete(id);
}

class MailyCache extends Dexie {
  accounts!: EntityTable<AccountDto, 'id'>;
  folders!: EntityTable<FolderDto, 'id'>;
  messages!: EntityTable<CachedMessage, 'id'>;
  bodies!: EntityTable<CachedBody, 'id'>;
  meta!: EntityTable<MetaRow, 'key'>;
  drafts!: EntityTable<DraftRecord, 'id'>;

  constructor() {
    super('maily');
    this.version(1).stores({
      accounts: 'id',
      folders: 'id, accountId',
      // multiEntry index on folderIds: a message lives in many folders (§7).
      messages: 'id, receivedAt, threadId, accountId, cachedAt, *folderIds',
      bodies: 'id, cachedAt',
      meta: 'key',
    });
    // v2 adds the compose drafts store (other tables carry over unchanged).
    this.version(2).stores({
      drafts: 'id, updatedAt',
    });
  }
}

export const cache = new MailyCache();

export async function cacheAccounts(rows: AccountDto[]): Promise<void> {
  await cache.accounts.bulkPut(rows);
}

export async function cacheFolders(rows: FolderDto[]): Promise<void> {
  await cache.folders.bulkPut(rows);
}

export async function cacheMessages(rows: MessageDto[]): Promise<void> {
  const now = Date.now();
  const fresh = rows.filter((m) => !isTombstoned(m.id));
  await cache.messages.bulkPut(fresh.map((m) => ({ ...m, cachedAt: now })));
}

export async function cacheBody(detail: MessageDetailDto): Promise<void> {
  if (isTombstoned(detail.id)) return;
  await cache.bodies.put({ ...detail, cachedAt: Date.now() });
  // Keep the list row's flags/snippet in sync with the freshly fetched detail.
  await cache.messages.put({
    id: detail.id,
    accountId: detail.accountId,
    threadId: detail.threadId,
    subject: detail.subject,
    fromName: detail.fromName,
    fromAddress: detail.fromAddress,
    to: detail.to,
    snippet: detail.snippet,
    sentAt: detail.sentAt,
    receivedAt: detail.receivedAt,
    seen: detail.seen,
    flagged: detail.flagged,
    localOnly: detail.localOnly,
    folderIds: detail.folderIds,
    attachments: detail.attachments,
    cachedAt: Date.now(),
  });
}

/** Optimistically reflect a flag change locally (server is still authoritative). */
export async function patchCachedFlags(
  id: string,
  flags: { seen?: boolean; flagged?: boolean },
): Promise<void> {
  await cache.messages.where('id').equals(id).modify(flags);
  await cache.bodies.where('id').equals(id).modify(flags);
}

/** Remove a message from the cache entirely (optimistic delete / tombstone signal). */
export async function removeCachedMessage(id: string): Promise<void> {
  removedRecently.set(id, Date.now());
  await cache.messages.delete(id);
  await cache.bodies.delete(id);
}

/**
 * Reconcile the cache against a freshly fetched HEAD page of a folder view, so
 * mail moved/deleted on another device (or while this one was offline and missed
 * the socket signals) disappears here too instead of lingering until eviction.
 *
 * The server returns the newest rows of `folderIds` sorted newest-first, so any
 * cached row in those folders that is STRICTLY newer than the oldest returned row
 * yet absent from the response provably left the folder — drop it (the backend
 * refetch restores it under its other folders on next view, same contract as the
 * `mail:archived` signal). When the response is short (`sawFullPage` false) it
 * covers the whole folder, so every absent cached row is stale.
 *
 * `excludeFolderIds` spares rows that the fetched view filters out server-side
 * (the virtual Archived view subtracts inbox/sent/… memberships): their absence
 * from the response proves nothing.
 */
export async function reconcileHeadPage(
  folderIds: string[],
  rows: MessageDto[],
  sawFullPage: boolean,
  excludeFolderIds?: Set<string>,
): Promise<void> {
  if (folderIds.length === 0) return;
  const present = new Set(rows.map((m) => m.id));
  const oldest = rows.length ? Math.min(...rows.map(receivedMs)) : 0;
  const stale = new Set<string>();
  // multiEntry index: a row in several scoped folders is visited once per match.
  await cache.messages
    .where('folderIds')
    .anyOf(folderIds)
    .each((m) => {
      if (present.has(m.id) || stale.has(m.id)) return;
      if (excludeFolderIds && m.folderIds.some((id) => excludeFolderIds.has(id))) return;
      if (!sawFullPage || receivedMs(m) > oldest) stale.add(m.id);
    });
  if (stale.size === 0) return;
  // Plain deletes, NOT removeCachedMessage: no tombstone, so a legitimate refetch
  // (e.g. viewing the folder the message moved to) can re-cache it immediately.
  const ids = [...stale];
  await cache.messages.bulkDelete(ids);
  await cache.bodies.bulkDelete(ids);
}

/**
 * Same idea for the virtual Starred view, where membership is the \Flagged flag
 * rather than a folder: a cached flagged row of this account inside the fetched
 * window but absent from the response was unstarred elsewhere — clear the flag
 * locally (the message itself still exists in its folders).
 */
export async function reconcileStarredPage(
  accountId: string,
  rows: MessageDto[],
  sawFullPage: boolean,
): Promise<void> {
  const present = new Set(rows.map((m) => m.id));
  const oldest = rows.length ? Math.min(...rows.map(receivedMs)) : 0;
  const unstarred: string[] = [];
  await cache.messages
    .where('accountId')
    .equals(accountId)
    .each((m) => {
      if (!m.flagged || present.has(m.id)) return;
      if (!sawFullPage || receivedMs(m) > oldest) unstarred.push(m.id);
    });
  for (const id of unstarred) {
    await cache.messages.where('id').equals(id).modify({ flagged: false });
    await cache.bodies.where('id').equals(id).modify({ flagged: false });
  }
}

/** Drop cache entries older than the configured client window. Call opportunistically on boot. */
export async function evictStale(): Promise<void> {
  const cutoff = Date.now() - getPrefs().clientCacheDays * DAY_MS;
  await cache.messages.where('cachedAt').below(cutoff).delete();
  await cache.bodies.where('cachedAt').below(cutoff).delete();
  // Abandoned drafts (never sent, never discarded) age out on the same window.
  await cache.drafts.where('updatedAt').below(cutoff).delete();
}

// --- Compose drafts ---

export async function saveDraft(draft: DraftRecord): Promise<void> {
  await cache.drafts.put(draft);
}

export async function getDraft(id: string): Promise<DraftRecord | undefined> {
  return cache.drafts.get(id);
}

export async function deleteDraft(id: string): Promise<void> {
  await cache.drafts.delete(id);
}
