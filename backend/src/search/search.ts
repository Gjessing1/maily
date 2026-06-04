/**
 * Hybrid search (ARCHITECTURE §1/§12): the local FTS5 index first, then an
 * optional server-side IMAP SEARCH fallback for mail older than the local cache
 * window. Fallback hits are ingested into the cache (so they gain an internal
 * UUID and become first-class, deep-linkable) and then returned from local.
 */
import { listFolders, type MessageRow } from '../db/queries.js';
import { searchLocal } from './local.js';
import { createLogger } from '../logger.js';
import { detectCapabilities, withTransientConnection } from '../imap/connection.js';
import type { FolderRow } from '../imap/folders.js';
import { getEngine } from '../imap/registry.js';
import { fetchAndStore, type SyncContext } from '../imap/sync.js';

const log = createLogger('search');

/** Most recent N server hits to ingest on a fallback — bounds the IMAP work. */
const FALLBACK_MAX = 30;

export interface SearchOptions {
  limit: number;
  /** Restrict (and enable IMAP fallback) to one account. */
  accountId?: string;
}

/** Pick the widest folder to search server-side: archive/All Mail, else INBOX. */
function fallbackFolder(accountId: string): FolderRow | undefined {
  const folders = listFolders(accountId);
  return (
    folders.find((f) => f.role === 'archive') ??
    folders.find((f) => f.role === 'inbox') ??
    folders[0]
  );
}

export async function searchMessages(query: string, opts: SearchOptions): Promise<MessageRow[]> {
  const local = searchLocal(query, opts.limit);
  // Enough local hits, or no account scope to fall back on → done.
  if (!opts.accountId || local.length >= opts.limit) return local;

  const accountId = opts.accountId;
  const engine = getEngine(accountId);
  const folder = fallbackFolder(accountId);
  if (!engine || !folder) return local;

  try {
    await withTransientConnection(engine.accountConfig, async (client) => {
      const lock = await client.getMailboxLock(folder.path);
      try {
        const ctx: SyncContext = {
          client,
          accountId,
          caps: detectCapabilities(client),
          log,
        };
        // IMAP TEXT search covers headers + body; ingest the most recent matches.
        const found = (await client.search({ text: query }, { uid: true })) || [];
        const uids = found.slice(-FALLBACK_MAX);
        if (uids.length > 0) await fetchAndStore(ctx, folder, uids);
      } finally {
        lock.release();
      }
    });
  } catch (err) {
    log.warn('IMAP fallback search failed:', (err as Error).message);
    return local;
  }

  // Re-run local search now that fallback hits are ingested.
  return searchLocal(query, opts.limit);
}
