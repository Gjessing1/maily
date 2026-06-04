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
  await cache.messages.bulkPut(rows.map((m) => ({ ...m, cachedAt: now })));
}

export async function cacheBody(detail: MessageDetailDto): Promise<void> {
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
  await cache.messages.delete(id);
  await cache.bodies.delete(id);
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
