/**
 * Dexie / IndexedDB cache. Per ARCHITECTURE §6 this is a VOLATILE ~30-day cache,
 * NOT durable storage — iOS evicts it without warning. The backend SQLite is the
 * source of truth; every read falls back to the network and a cold/empty cache is
 * expected. We store list DTOs and (separately) full bodies so list views stay light.
 */
import Dexie, { type EntityTable } from 'dexie';
import type { AccountDto, FolderDto, MessageDetailDto, MessageDto } from '@maily/shared';

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

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // ~30 days (§6).

class MailyCache extends Dexie {
  accounts!: EntityTable<AccountDto, 'id'>;
  folders!: EntityTable<FolderDto, 'id'>;
  messages!: EntityTable<CachedMessage, 'id'>;
  bodies!: EntityTable<CachedBody, 'id'>;
  meta!: EntityTable<MetaRow, 'key'>;

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

/** Drop cache entries older than the TTL. Call opportunistically on boot. */
export async function evictStale(): Promise<void> {
  const cutoff = Date.now() - CACHE_TTL_MS;
  await cache.messages.where('cachedAt').below(cutoff).delete();
  await cache.bodies.where('cachedAt').below(cutoff).delete();
}
