import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { api } from '../api/client';
import { useAccounts, useFolders, useMessages } from '../state/data';
import { cache, patchCachedFlags } from '../db/cache';
import { requestDelete } from '../state/undo';
import { MessageRow } from '../components/MessageRow';
import { FolderDrawer } from '../components/FolderDrawer';
import { ReaderView } from './Reader';
import { usePrefs } from '../state/prefs';
import { useMediaQuery } from '../ui/useMediaQuery';
import { Spinner } from '../ui/Spinner';
import { MenuIcon, PencilIcon, SearchIcon } from '../ui/icons';

export function Home() {
  const [params, setParams] = useSearchParams();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const accounts = useAccounts();
  const prefs = usePrefs();
  // Split reading pane only engages on wide screens; mobile always opens full-screen.
  const isWide = useMediaQuery('(min-width: 768px)');
  const splitMode = prefs.readingPane !== 'none' && isWide;
  const folderId = params.get('folder') ?? undefined;
  const selectedId = params.get('msg') ?? undefined;

  // In split mode a row click sets the `msg` query param (stays on Home, no remount)
  // instead of navigating to the full-screen reader.
  const selectTo = useCallback(
    (id: string) => {
      const next = new URLSearchParams(params);
      next.set('msg', id);
      return `?${next.toString()}`;
    },
    [params],
  );
  const closeReader = useCallback(() => {
    const next = new URLSearchParams(params);
    next.delete('msg');
    setParams(next, { replace: true });
  }, [params, setParams]);
  const firstFolders = useFolders(accounts?.[0]?.id);

  // Resolve a default folder (first account's inbox) once folders arrive.
  useEffect(() => {
    if (folderId || !firstFolders?.length) return;
    const inbox = firstFolders.find((f) => f.role === 'inbox') ?? firstFolders[0]!;
    setParams({ folder: inbox.id }, { replace: true });
  }, [folderId, firstFolders, setParams]);

  const folder = useLiveQuery(
    () => (folderId ? cache.folders.get(folderId) : undefined),
    [folderId],
  );

  const { messages, loading, refreshing, hasMore, error, loadMore } = useMessages(folderId);

  // Swipe-to-delete: stage the delete with an undo window (drops the row locally
  // now, commits the Trash move server-side after the snackbar elapses).
  const handleDelete = useCallback((id: string) => {
    void requestDelete(id);
  }, []);

  // Optimistic swipe-to-toggle-read: flip the flag locally, reconcile on the server.
  const handleToggleRead = useCallback((id: string, seen: boolean) => {
    void patchCachedFlags(id, { seen });
    api.setFlags(id, { seen }).catch(() => void patchCachedFlags(id, { seen: !seen }));
  }, []);

  // Infinite scroll sentinel.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore) return;
    const obs = new IntersectionObserver((entries) => entries[0]?.isIntersecting && loadMore(), {
      rootMargin: '400px',
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMore, loadMore, messages]);

  const listPane = (
    <div className="flex h-full min-h-0 flex-col">
      <header className="safe-top sticky top-0 z-10 border-b border-border bg-bg/85 backdrop-blur">
        <div className="flex items-center gap-1 px-2 py-2">
          <button
            onClick={() => setDrawerOpen(true)}
            className="rounded-full p-2 text-fg active:bg-surface-2"
            aria-label="Folders"
          >
            <MenuIcon />
          </button>
          <h1 className="flex-1 truncate text-lg font-semibold capitalize">
            {folder?.name ?? 'Inbox'}
          </h1>
          <Link
            to="/search"
            className="rounded-full p-2 text-fg active:bg-surface-2"
            aria-label="Search"
          >
            <SearchIcon />
          </Link>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto no-scrollbar">
        {error && <p className="px-4 py-2 text-sm text-danger">Couldn’t refresh: {error}</p>}

        {loading ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : messages && messages.length > 0 ? (
          <>
            {messages.map((m) => (
              <MessageRow
                key={m.id}
                message={m}
                onDelete={handleDelete}
                onToggleRead={handleToggleRead}
                swipeRight={prefs.swipeRight}
                swipeLeft={prefs.swipeLeft}
                to={splitMode ? selectTo(m.id) : undefined}
                selected={splitMode && m.id === selectedId}
              />
            ))}
            <div ref={sentinel} className="flex justify-center py-6">
              {refreshing && hasMore && <Spinner />}
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center gap-2 py-20 text-center text-muted">
            <p>No messages here.</p>
            {refreshing && <Spinner />}
          </div>
        )}
      </main>
    </div>
  );

  return (
    <div className="h-full">
      {splitMode ? (
        <div className={`flex h-full ${prefs.readingPane === 'right' ? 'flex-row' : 'flex-col'}`}>
          <div
            className={
              prefs.readingPane === 'right'
                ? 'w-[22rem] shrink-0 border-r border-border lg:w-[26rem]'
                : 'h-1/2 shrink-0 border-b border-border'
            }
          >
            {listPane}
          </div>
          <div className="min-h-0 min-w-0 flex-1">
            <ReaderView id={selectedId} onClose={closeReader} embedded />
          </div>
        </div>
      ) : (
        listPane
      )}

      <Link
        to="/compose"
        className="safe-bottom fixed bottom-5 right-5 z-10 flex size-14 items-center justify-center rounded-full bg-accent text-white shadow-lg shadow-accent/30 transition active:scale-95"
        aria-label="Compose"
      >
        <PencilIcon />
      </Link>

      <FolderDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        accounts={accounts ?? []}
        selectedFolderId={folderId}
        onSelect={(f) => setParams({ folder: f.id })}
      />
    </div>
  );
}
