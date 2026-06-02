import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { api } from '../api/client';
import { useAccounts, useFolders, useMessages } from '../state/data';
import { cache, patchCachedFlags, removeCachedMessage } from '../db/cache';
import { MessageRow } from '../components/MessageRow';
import { FolderDrawer } from '../components/FolderDrawer';
import { Spinner } from '../ui/Spinner';
import { MenuIcon, PencilIcon, SearchIcon } from '../ui/icons';

export function Home() {
  const [params, setParams] = useSearchParams();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const accounts = useAccounts();
  const folderId = params.get('folder') ?? undefined;
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

  // Optimistic swipe-to-delete: drop the row locally, move to Trash on the server.
  const handleDelete = useCallback((id: string) => {
    void removeCachedMessage(id);
    api.deleteMessage(id).catch(() => undefined);
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

  return (
    <div className="flex h-full flex-col">
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
