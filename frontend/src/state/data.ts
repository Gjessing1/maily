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
import {
  cache,
  cacheAccounts,
  cacheBody,
  cacheFolders,
  cacheMessages,
  type CachedMessage,
} from '../db/cache';

const PAGE = 50;

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

  const messages = useLiveQuery(async () => {
    if (!folderId) return [];
    const rows = await cache.messages.where('folderIds').equals(folderId).toArray();
    return rows.sort((a, b) => receivedMs(b) - receivedMs(a));
  }, [folderId]);

  const refresh = useCallback(() => {
    if (!folderId) return;
    setRefreshing(true);
    setError(null);
    api
      .messages(folderId, { limit: PAGE })
      .then(async (rows) => {
        await cacheMessages(rows);
        setHasMore(rows.length === PAGE);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setRefreshing(false));
  }, [folderId]);

  const loadMore = useCallback(() => {
    if (!folderId || !messages?.length) return;
    const oldest = messages[messages.length - 1];
    const before = oldest ? receivedMs(oldest) : 0;
    if (!before) return;
    setRefreshing(true);
    api
      .messages(folderId, { limit: PAGE, before })
      .then(async (rows) => {
        await cacheMessages(rows);
        setHasMore(rows.length === PAGE);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setRefreshing(false));
  }, [folderId, messages]);

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
