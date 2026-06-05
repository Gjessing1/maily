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
import { isUnifiedView } from './unified';

function receivedMs(m: { receivedAt: string | null }): number {
  return m.receivedAt ? Date.parse(m.receivedAt) : 0;
}

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
    api
      .folders(accountId)
      .then(cacheFolders)
      .catch(() => undefined);
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
  // The virtual "Unified Inbox" merges every account's inbox; offline it unions the
  // cached messages of all inbox-role folders.
  const unified = isUnifiedView(folderId);

  const messages = useLiveQuery(async () => {
    if (!folderId) return [];
    let rows: CachedMessage[];
    if (unified) {
      const inboxIds = (await cache.folders.toArray())
        .filter((f) => f.role === 'inbox')
        .map((f) => f.id);
      rows = inboxIds.length
        ? await cache.messages.where('folderIds').anyOf(inboxIds).toArray()
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
  }, [folderId, archived, accountId, unified, unreadAtTop]);

  // One page fetch for the unified inbox, an archived view, or a real folder.
  const fetchPage = useCallback(
    (before?: number) =>
      unified
        ? api.unifiedInbox({ limit: PAGE, before })
        : archived && accountId
          ? api.archived(accountId, { limit: PAGE, before })
          : api.messages(folderId!, { limit: PAGE, before }),
    [unified, archived, accountId, folderId, PAGE],
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
