/**
 * Data hooks: read from the Dexie cache reactively (instant paint, works offline)
 * while refetching from the backend in the background. The backend is the source
 * of truth (§6); the cache is a disposable accelerator, so a cold/empty cache just
 * shows a spinner until the network fills it.
 */
import { useCallback, useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { AccountDto, FolderDto, MessageDetailDto } from '@maily/shared';
import { api } from '../api/client';
import { usePrefs } from './prefs';
import {
  cache,
  cacheAccounts,
  cacheBody,
  cacheFolders,
  cacheMessages,
  type CachedMessage,
} from '../db/cache';
import { archivedAccountId, isArchivedView, NON_ARCHIVE_ROLES } from './archived';
import { isStarredView, starredAccountId } from './starred';
import { isUnifiedView, unifiedRole } from './unified';

function receivedMs(m: { receivedAt: string | null }): number {
  return m.receivedAt ? Date.parse(m.receivedAt) : 0;
}

/** How many of the top list rows to warm the body cache for (see prefetch below). */
const PREFETCH_BODIES = 8;

export function useAccounts(): AccountDto[] | undefined {
  const accounts = useLiveQuery(() => cache.accounts.toArray());
  useEffect(() => {
    api
      .accounts()
      .then(cacheAccounts)
      .catch(() => undefined);
  }, []);
  return accounts;
}

export function useFolders(accountId: string | undefined): FolderDto[] | undefined {
  const folders = useLiveQuery(
    () => (accountId ? cache.folders.where('accountId').equals(accountId).toArray() : []),
    [accountId],
  );
  useEffect(() => {
    if (!accountId) return;
    const load = () =>
      api
        .folders(accountId)
        .then(cacheFolders)
        .catch(() => undefined);
    load();
    // The drawer stays mounted for the app's lifetime, so this one fetch is the only
    // chance to populate folders. If it fails (backend restart, network blip, cold
    // boot) and the IndexedDB cache is empty/evicted (§6, routine on iOS), the drawer
    // is left with no inbox until a full app restart — the "vanished inbox". Re-pull
    // whenever the app regains focus or connectivity so the folder list self-heals.
    const onVisible = () => {
      if (document.visibilityState === 'visible') load();
    };
    window.addEventListener('online', load);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', load);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [accountId]);
  return folders;
}

interface MessagesResult {
  messages: CachedMessage[] | undefined;
  loading: boolean;
  refreshing: boolean;
  hasMore: boolean;
  error: string | null;
  loadMore: () => void;
  refresh: () => void;
}

export function useMessages(folderId: string | undefined): MessagesResult {
  const [refreshing, setRefreshing] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { unreadAtTop, pageSize } = usePrefs();
  const PAGE = pageSize;

  // The virtual "Archived" view has no real folder id; it reads its own endpoint
  // and, offline, filters the cached archive-folder rows by the same role subtraction.
  const archived = isArchivedView(folderId);
  const accountId = archived ? archivedAccountId(folderId) : undefined;
  // The virtual unified views ("All inboxes", "All sent", …) merge every account's
  // folder of one role; offline they union the cached messages of those folders.
  const unified = isUnifiedView(folderId);
  const unifiedFor = unifiedRole(folderId);
  // The virtual "Starred" view is the account's \Flagged mail; offline it filters the
  // cached rows of that account on the flag (no folder membership involved).
  const starred = isStarredView(folderId);
  const starredFor = starred ? starredAccountId(folderId) : undefined;

  const messages = useLiveQuery(async () => {
    if (!folderId) return [];
    let rows: CachedMessage[];
    if (starred && starredFor) {
      rows = (await cache.messages.where('accountId').equals(starredFor).toArray()).filter(
        (m) => m.flagged,
      );
    } else if (unified && unifiedFor) {
      const roleFolderIds = (await cache.folders.toArray())
        .filter((f) => f.role === unifiedFor)
        .map((f) => f.id);
      rows = roleFolderIds.length
        ? await cache.messages.where('folderIds').anyOf(roleFolderIds).toArray()
        : [];
    } else if (archived && accountId) {
      const folders = await cache.folders.where('accountId').equals(accountId).toArray();
      const archiveId = folders.find((f) => f.role === 'archive')?.id;
      if (!archiveId) return [];
      const excluded = new Set(
        folders.filter((f) => NON_ARCHIVE_ROLES.has(f.role)).map((f) => f.id),
      );
      const inArchive = await cache.messages.where('folderIds').equals(archiveId).toArray();
      rows = inArchive.filter((m) => !m.folderIds.some((id) => excluded.has(id)));
    } else {
      rows = await cache.messages.where('folderIds').equals(folderId).toArray();
    }
    // Newest-first always; optionally float unread above read as the primary key.
    return rows.sort((a, b) => {
      if (unreadAtTop && a.seen !== b.seen) return a.seen ? 1 : -1;
      return receivedMs(b) - receivedMs(a);
    });
  }, [folderId, archived, accountId, unified, unifiedFor, starred, starredFor, unreadAtTop]);

  // One page fetch for a unified view, an archived view, or a real folder. The inbox
  // keeps its dedicated endpoint; other roles go through the generic unified route.
  const fetchPage = useCallback(
    (before?: number) =>
      starred && starredFor
        ? api.starred(starredFor, { limit: PAGE, before })
        : unifiedFor
          ? unifiedFor === 'inbox'
            ? api.unifiedInbox({ limit: PAGE, before })
            : api.unified(unifiedFor, { limit: PAGE, before })
          : archived && accountId
            ? api.archived(accountId, { limit: PAGE, before })
            : api.messages(folderId!, { limit: PAGE, before }),
    [starred, starredFor, unifiedFor, archived, accountId, folderId, PAGE],
  );

  const refresh = useCallback(() => {
    if (!folderId) return;
    setRefreshing(true);
    setError(null);
    fetchPage()
      .then(async (rows) => {
        await cacheMessages(rows);
        setHasMore(rows.length === PAGE);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setRefreshing(false));
  }, [folderId, PAGE, fetchPage]);

  const loadMore = useCallback(() => {
    if (!folderId || !messages?.length) return;
    const oldest = messages[messages.length - 1];
    const before = oldest ? receivedMs(oldest) : 0;
    if (!before) return;
    setRefreshing(true);
    fetchPage(before)
      .then(async (rows) => {
        await cacheMessages(rows);
        setHasMore(rows.length === PAGE);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setRefreshing(false));
  }, [folderId, messages, PAGE, fetchPage]);

  // Refetch the head of the folder whenever it changes.
  useEffect(() => {
    setHasMore(true);
    refresh();
  }, [refresh]);

  // Warm the body cache for the top rows so opening one of them is instant: the
  // reader reads its body straight from Dexie instead of waiting on an HTTP round
  // trip per tap. Fire-and-forget and sequential so it never competes with a
  // user-initiated open; skips bodies already cached and bails on the first network
  // error (a refocus/refresh will retry). Keyed on the id list so it only re-runs
  // when the head of the folder actually changes, not on every liveQuery tick.
  const topIdsKey = (messages ?? [])
    .slice(0, PREFETCH_BODIES)
    .map((m) => m.id)
    .join(',');
  useEffect(() => {
    if (!topIdsKey) return;
    const ids = topIdsKey.split(',');
    let cancelled = false;
    void (async () => {
      for (const id of ids) {
        if (cancelled) return;
        if (await cache.bodies.get(id)) continue;
        try {
          await api.message(id).then(cacheBody);
        } catch {
          return;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [topIdsKey]);

  return {
    messages,
    loading: messages === undefined,
    refreshing,
    hasMore,
    error,
    loadMore,
    refresh,
  };
}

/**
 * Reactive thread membership for the conversation reader. Reads the cached rows that
 * share `threadId` (so per-message flag/delete updates reflect live) while fetching
 * the authoritative whole thread — which spans folders, e.g. Sent replies — from the
 * backend and caching it. Returns the members oldest-first; the reader orders them.
 */
export function useThread(
  messageId: string | undefined,
  threadId: string | null | undefined,
): CachedMessage[] {
  const members = useLiveQuery(async () => {
    if (!messageId) return [];
    // No thread id (or not loaded yet) → the message is its own one-message thread.
    if (!threadId) {
      const m = await cache.messages.get(messageId);
      return m ? [m] : [];
    }
    return cache.messages.where('threadId').equals(threadId).toArray();
  }, [messageId, threadId]);

  useEffect(() => {
    if (!messageId) return;
    api
      .thread(messageId)
      .then(cacheMessages)
      .catch(() => undefined);
  }, [messageId]);

  return (members ?? []).slice().sort((a, b) => receivedMs(a) - receivedMs(b));
}

interface DetailResult {
  detail: MessageDetailDto | undefined;
  loading: boolean;
  error: string | null;
}

export function useMessageDetail(id: string | undefined): DetailResult {
  const [error, setError] = useState<string | null>(null);
  const cached = useLiveQuery(() => (id ? cache.bodies.get(id) : undefined), [id]);

  useEffect(() => {
    if (!id) return;
    setError(null);
    api
      .message(id)
      .then(cacheBody)
      .catch((e: Error) => setError(e.message));
  }, [id]);

  return { detail: cached, loading: cached === undefined && !error, error };
}
