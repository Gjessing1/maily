/**
 * Data hooks: read from the Dexie cache reactively (instant paint, works offline)
 * while refetching from the backend in the background. The backend is the source
 * of truth (§6); the cache is a disposable accelerator, so a cold/empty cache just
 * shows a spinner until the network fills it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { AccountDto, FolderDto, MessageDetailDto, MessageDto } from '@maily/shared';
import { api } from '../api/client';
import { onSocketReconnect } from '../api/socket';
import { usePrefs } from './prefs';
import {
  cache,
  cacheAccounts,
  cacheBody,
  cacheFolders,
  cacheMessages,
  reconcileHeadPage,
  reconcileStarredPage,
  reconcileUnreadPage,
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

/**
 * Page size for the dedicated unread fetch (`?unread=1`) and cap for the unread section
 * of the list. Matches the server's MAX_PAGE — with "unread at top" on, EVERY unread
 * message of the view (up to this cap) is served on page one straight from the server,
 * regardless of how deep the date-ordered pages have been scrolled.
 */
const UNREAD_PAGE = 200;

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

  // How many rows the view currently shows. The cache can hold up to a year of rows
  // (clientCacheDays), so both the Dexie read and the DOM must stay bounded to a
  // window that grows page-by-page with scrolling — never "everything cached".
  const [displayLimit, setDisplayLimit] = useState(PAGE);
  useEffect(() => setDisplayLimit(PAGE), [folderId, PAGE]);

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
    // Resolve the view to a membership predicate, then walk the receivedAt index
    // newest-first and stop once the display window is full. receivedAt is an ISO
    // string, so index order IS chronological order; for the dense default views
    // (inbox, unified inbox) this reads ~displayLimit rows instead of the whole
    // table, which is what made a cold Home remount take seconds. Rows with a null
    // receivedAt aren't in the index and are skipped — keyset paging (`before`)
    // could never reach past them anyway.
    let match: (m: CachedMessage) => boolean;
    if (starred && starredFor) {
      match = (m) => m.accountId === starredFor && m.flagged;
    } else if (unified && unifiedFor) {
      const roleFolderIds = new Set(
        (await cache.folders.toArray()).filter((f) => f.role === unifiedFor).map((f) => f.id),
      );
      if (roleFolderIds.size === 0) return [];
      match = (m) => m.folderIds.some((id) => roleFolderIds.has(id));
    } else if (archived && accountId) {
      const folders = await cache.folders.where('accountId').equals(accountId).toArray();
      const archiveId = folders.find((f) => f.role === 'archive')?.id;
      if (!archiveId) return [];
      const excluded = new Set(
        folders.filter((f) => NON_ARCHIVE_ROLES.has(f.role)).map((f) => f.id),
      );
      match = (m) => m.folderIds.includes(archiveId) && !m.folderIds.some((id) => excluded.has(id));
    } else {
      match = (m) => m.folderIds.includes(folderId);
    }
    if (!unreadAtTop) {
      return cache.messages
        .orderBy('receivedAt')
        .reverse()
        .filter(match)
        .limit(displayLimit)
        .toArray();
    }
    // Unread-at-top: the unread section comes off the sparse `unreadAt` index, which
    // holds ONLY unseen rows — so every cached unread message of the view surfaces on
    // page one (not just ones inside the scrolled window), at the cost of walking the
    // handful of unread rows. The read section fills the date-ordered window below it.
    const unread = await cache.messages
      .orderBy('unreadAt')
      .reverse()
      .filter(match)
      .limit(UNREAD_PAGE)
      .toArray();
    const read = await cache.messages
      .orderBy('receivedAt')
      .reverse()
      .filter((m) => m.seen && match(m))
      .limit(displayLimit)
      .toArray();
    return [...unread, ...read]; // both sections are newest-first from their index
  }, [
    folderId,
    archived,
    accountId,
    unified,
    unifiedFor,
    starred,
    starredFor,
    unreadAtTop,
    displayLimit,
  ]);

  // One page fetch for a unified view, an archived view, or a real folder. The inbox
  // keeps its dedicated endpoint; other roles go through the generic unified route.
  // `unread: true` asks for the newest unseen rows only (no cursor, bigger cap).
  const fetchPage = useCallback(
    (opts: { before?: number; unread?: boolean } = {}) => {
      const q = {
        limit: opts.unread ? UNREAD_PAGE : PAGE,
        before: opts.before,
        unread: opts.unread,
      };
      return starred && starredFor
        ? api.starred(starredFor, q)
        : unifiedFor
          ? unifiedFor === 'inbox'
            ? api.unifiedInbox(q)
            : api.unified(unifiedFor, q)
          : archived && accountId
            ? api.archived(accountId, q)
            : api.messages(folderId!, q);
    },
    [starred, starredFor, unifiedFor, archived, accountId, folderId, PAGE],
  );

  // The view the hook currently renders; async completions compare against it so a
  // slow response from a previous folder can't set this view's hasMore/error state.
  const viewRef = useRef(folderId);
  viewRef.current = folderId;
  // Head-refresh in flight for which view (coalesces the visibility/online/socket
  // triggers, which often fire together) — a view SWITCH still refreshes immediately.
  const refreshingViewRef = useRef<string | null>(null);
  const loadingMoreRef = useRef(false);

  // After a successful head fetch, drop cached rows that vanished from the fetched
  // view server-side (moved/deleted on another device while signals were missed).
  // Scoped to the view that was FETCHED, so it stays valid even if the user has
  // already navigated elsewhere by the time the response lands.
  const reconcile = useCallback(
    async (rows: MessageDto[], sawFullPage: boolean) => {
      if (starred && starredFor) {
        await reconcileStarredPage(starredFor, rows, sawFullPage);
      } else if (unified && unifiedFor) {
        const scope = (await cache.folders.toArray())
          .filter((f) => f.role === unifiedFor)
          .map((f) => f.id);
        await reconcileHeadPage(scope, rows, sawFullPage);
      } else if (archived && accountId) {
        const folders = await cache.folders.where('accountId').equals(accountId).toArray();
        const archiveId = folders.find((f) => f.role === 'archive')?.id;
        if (!archiveId) return;
        // The Archived view subtracts inbox/sent/… members server-side, so their
        // absence from the response proves nothing — spare them.
        const excluded = new Set(
          folders.filter((f) => NON_ARCHIVE_ROLES.has(f.role)).map((f) => f.id),
        );
        await reconcileHeadPage([archiveId], rows, sawFullPage, excluded);
      } else if (folderId) {
        await reconcileHeadPage([folderId], rows, sawFullPage);
      }
    },
    [starred, starredFor, unified, unifiedFor, archived, accountId, folderId],
  );

  // Reconcile the unread page (see reconcileUnreadPage): a cached-unseen row inside the
  // fetched window but absent from the response was read elsewhere — unbold it locally.
  // Starred is flag-scoped, not folder-scoped, so it has no scope to reconcile against.
  const reconcileUnread = useCallback(
    async (rows: MessageDto[]) => {
      const sawFullPage = rows.length === UNREAD_PAGE;
      if (unified && unifiedFor) {
        const scope = (await cache.folders.toArray())
          .filter((f) => f.role === unifiedFor)
          .map((f) => f.id);
        await reconcileUnreadPage(scope, rows, sawFullPage);
      } else if (archived && accountId) {
        const folders = await cache.folders.where('accountId').equals(accountId).toArray();
        const archiveId = folders.find((f) => f.role === 'archive')?.id;
        if (!archiveId) return;
        const excluded = new Set(
          folders.filter((f) => NON_ARCHIVE_ROLES.has(f.role)).map((f) => f.id),
        );
        await reconcileUnreadPage([archiveId], rows, sawFullPage, excluded);
      } else if (!starred && folderId) {
        await reconcileUnreadPage([folderId], rows, sawFullPage);
      }
    },
    [unified, unifiedFor, archived, accountId, starred, folderId],
  );

  const refresh = useCallback(() => {
    if (!folderId) return;
    if (refreshingViewRef.current === folderId) return; // already refreshing this view
    refreshingViewRef.current = folderId;
    const view = folderId;
    setRefreshing(true);
    setError(null);
    // With unread-at-top on, the unread page rides along with the head page so page
    // one always carries every unread message — the server serves both from its
    // first-page cache, so this is two cheap requests, not two heavy queries.
    Promise.all([fetchPage(), unreadAtTop ? fetchPage({ unread: true }) : null])
      .then(async ([rows, unreadRows]) => {
        // Cache + reconcile unconditionally — the data is valid for the view it was
        // fetched for regardless of where the user has navigated since.
        await cacheMessages(rows);
        if (unreadRows) await cacheMessages(unreadRows);
        await reconcile(rows, rows.length === PAGE);
        if (unreadRows) await reconcileUnread(unreadRows);
        if (viewRef.current === view) setHasMore(rows.length === PAGE);
      })
      .catch((e: Error) => {
        if (viewRef.current === view) setError(e.message);
      })
      .finally(() => {
        if (refreshingViewRef.current === view) refreshingViewRef.current = null;
        if (viewRef.current === view) setRefreshing(false);
      });
  }, [folderId, PAGE, unreadAtTop, fetchPage, reconcile, reconcileUnread]);

  const loadMore = useCallback(() => {
    if (!folderId || !messages?.length) return;
    if (loadingMoreRef.current) return; // scroll handlers fire in bursts — one page at a time
    const oldest = messages[messages.length - 1];
    const before = oldest ? receivedMs(oldest) : 0;
    if (!before) return;
    loadingMoreRef.current = true;
    // Reveal the next window of already-cached rows right away (works offline);
    // the fetch below tops the cache up where the window outruns it.
    setDisplayLimit((n) => n + PAGE);
    const view = folderId;
    setRefreshing(true);
    fetchPage({ before })
      .then(async (rows) => {
        await cacheMessages(rows);
        if (viewRef.current === view) setHasMore(rows.length === PAGE);
      })
      .catch((e: Error) => {
        if (viewRef.current === view) setError(e.message);
      })
      .finally(() => {
        loadingMoreRef.current = false;
        if (viewRef.current === view) setRefreshing(false);
      });
  }, [folderId, messages, PAGE, fetchPage]);

  // Refetch the head of the folder whenever it changes.
  useEffect(() => {
    setHasMore(true);
    refresh();
  }, [refresh]);

  // Self-heal stale read/unread (and other flag) state: a client that was backgrounded
  // or briefly disconnected misses the live socket signals, so reconcile the head of the
  // folder with the backend whenever the app regains focus/connectivity or the socket
  // reconnects. The backend is the source of truth (§6), so this keeps the desktop app,
  // phone PWA and browser in agreement without polling.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', onVisible);
    const offReconnect = onSocketReconnect(refresh);
    return () => {
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', onVisible);
      offReconnect();
    };
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
