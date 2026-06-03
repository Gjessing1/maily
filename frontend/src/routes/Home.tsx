import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { api } from '../api/client';
import { useAccounts, useFolders, useMessages } from '../state/data';
import { cache, patchCachedFlags, removeCachedMessage } from '../db/cache';
import { requestDelete } from '../state/undo';
import { MessageRow } from '../components/MessageRow';
import { MessageContextMenu } from '../components/MessageContextMenu';
import { FolderDrawer } from '../components/FolderDrawer';
import { ReaderView } from './Reader';
import { isArchivedView } from '../state/archived';
import { usePrefs } from '../state/prefs';
import { useMediaQuery } from '../ui/useMediaQuery';
import { Spinner } from '../ui/Spinner';
import {
  ArchiveIcon,
  CloseIcon,
  MailIcon,
  MailOpenIcon,
  MenuIcon,
  PencilIcon,
  SearchIcon,
  TrashIcon,
} from '../ui/icons';

/** Subtle section header dividing the unread/read groups (Gmail-desktop style). */
function SectionLabel({ children, divider }: { children: string; divider?: boolean }) {
  return (
    <div
      className={`px-4 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-faint ${
        divider ? 'mt-1 border-t border-border' : ''
      }`}
    >
      {children}
    </div>
  );
}

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
    () => (folderId && !isArchivedView(folderId) ? cache.folders.get(folderId) : undefined),
    [folderId],
  );
  // The Archived view is synthetic (no cached folder row), so name it explicitly.
  const folderName = isArchivedView(folderId) ? 'Archive' : (folder?.name ?? 'Inbox');

  const { messages, loading, refreshing, hasMore, error, loadMore } = useMessages(folderId);

  // Gmail-style unread/read section break: only when "unread at top" is on and the
  // list actually straddles both groups. `unreadCount` is also the index of the
  // first read row, since useMessages sorts all unread ahead of read.
  const unreadCount = prefs.unreadAtTop ? (messages?.filter((m) => !m.seen).length ?? 0) : 0;
  const showSections =
    prefs.unreadAtTop && !!messages && unreadCount > 0 && unreadCount < messages.length;

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

  // Single archive (context menu): drop locally, move the inbox copy server-side.
  const handleArchive = useCallback((id: string) => {
    void removeCachedMessage(id);
    api.archiveMessage(id).catch(() => undefined);
  }, []);

  // ── Right-click context menu (desktop) ──────────────────────────────────────
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const openMenu = useCallback((id: string, x: number, y: number) => setMenu({ id, x, y }), []);
  const closeMenu = useCallback(() => setMenu(null), []);

  // ── Multi-select (long-press / right-click a row to enter) ──────────────────
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const selectionMode = selectedIds.size > 0;

  // Leaving the folder abandons any selection.
  useEffect(() => setSelectedIds(new Set()), [folderId]);

  const enterSelect = useCallback((id: string) => {
    setSelectedIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);
  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const clearSelect = useCallback(() => setSelectedIds(new Set()), []);

  const bulkMarkRead = useCallback(
    (seen: boolean) => {
      for (const id of selectedIds) {
        void patchCachedFlags(id, { seen });
        api.setFlags(id, { seen }).catch(() => void patchCachedFlags(id, { seen: !seen }));
      }
      clearSelect();
    },
    [selectedIds, clearSelect],
  );
  const bulkArchive = useCallback(() => {
    for (const id of selectedIds) {
      void removeCachedMessage(id);
      api.archiveMessage(id).catch(() => undefined);
    }
    clearSelect();
  }, [selectedIds, clearSelect]);
  const bulkDelete = useCallback(() => {
    // Bulk delete commits immediately (recoverable from Trash); the single-undo
    // snackbar only models one pending delete, so it's bypassed here.
    for (const id of selectedIds) {
      void removeCachedMessage(id);
      api.deleteMessage(id).catch(() => undefined);
    }
    clearSelect();
  }, [selectedIds, clearSelect]);

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
        {selectionMode ? (
          <div className="flex items-center gap-1 px-2 py-2">
            <button
              onClick={clearSelect}
              className="rounded-full p-2 text-fg active:bg-surface-2"
              aria-label="Cancel selection"
            >
              <CloseIcon />
            </button>
            <h1 className="flex-1 truncate text-lg font-semibold tabular-nums">
              {selectedIds.size}
            </h1>
            <button
              onClick={() => bulkMarkRead(true)}
              className="rounded-full p-2 text-fg active:bg-surface-2"
              aria-label="Mark as read"
            >
              <MailIcon />
            </button>
            <button
              onClick={() => bulkMarkRead(false)}
              className="rounded-full p-2 text-fg active:bg-surface-2"
              aria-label="Mark as unread"
            >
              <MailOpenIcon />
            </button>
            <button
              onClick={bulkArchive}
              className="rounded-full p-2 text-fg active:bg-surface-2"
              aria-label="Archive"
            >
              <ArchiveIcon />
            </button>
            <button
              onClick={bulkDelete}
              className="rounded-full p-2 text-fg active:bg-surface-2"
              aria-label="Delete"
            >
              <TrashIcon />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1 px-2 py-2">
            {/* On mobile, Folders/Search live in the bottom bar; keep them up top on wide screens. */}
            {isWide && (
              <button
                onClick={() => setDrawerOpen(true)}
                className="rounded-full p-2 text-fg active:bg-surface-2"
                aria-label="Folders"
              >
                <MenuIcon />
              </button>
            )}
            <h1 className="flex-1 truncate px-2 text-lg font-semibold capitalize">{folderName}</h1>
            {isWide && (
              <Link
                to="/search"
                className="rounded-full p-2 text-fg active:bg-surface-2"
                aria-label="Search"
              >
                <SearchIcon />
              </Link>
            )}
          </div>
        )}
      </header>

      <main className={`flex-1 overflow-y-auto no-scrollbar ${!isWide ? 'pb-16' : ''}`}>
        {error && <p className="px-4 py-2 text-sm text-danger">Couldn’t refresh: {error}</p>}

        {loading ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : messages && messages.length > 0 ? (
          <>
            {messages.map((m, i) => (
              <Fragment key={m.id}>
                {showSections && i === 0 && <SectionLabel>Unread</SectionLabel>}
                {showSections && i === unreadCount && (
                  <SectionLabel divider>Everything else</SectionLabel>
                )}
                <MessageRow
                  message={m}
                  onDelete={handleDelete}
                  onToggleRead={handleToggleRead}
                  swipeRight={prefs.swipeRight}
                  swipeLeft={prefs.swipeLeft}
                  to={splitMode ? selectTo(m.id) : undefined}
                  selected={splitMode && m.id === selectedId}
                  selectionMode={selectionMode}
                  checked={selectedIds.has(m.id)}
                  onEnterSelect={enterSelect}
                  onToggleSelect={toggleSelect}
                  onContextMenu={openMenu}
                />
              </Fragment>
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

      {/* Wide screens keep the floating compose button; on mobile compose moves into
          the bottom bar with the rest of the navigation. */}
      {isWide && !selectionMode && (
        <Link
          to="/compose"
          className="safe-bottom fixed bottom-5 right-5 z-10 flex size-14 items-center justify-center rounded-full bg-accent text-white shadow-lg shadow-accent/30 transition active:scale-95"
          aria-label="Compose"
        >
          <PencilIcon />
        </Link>
      )}

      {/* Mobile bottom navigation: primary nav + actions within thumb reach. */}
      {!isWide && !selectionMode && (
        <nav className="safe-bottom fixed inset-x-0 bottom-0 z-20 flex items-stretch justify-around border-t border-border bg-bg/95 backdrop-blur">
          <button
            onClick={() => setDrawerOpen(true)}
            className="flex flex-1 flex-col items-center gap-0.5 py-2 text-faint active:text-fg"
            aria-label="Folders"
          >
            <MenuIcon />
            <span className="text-[10px]">Folders</span>
          </button>
          <Link
            to="/search"
            className="flex flex-1 flex-col items-center gap-0.5 py-2 text-faint active:text-fg"
            aria-label="Search"
          >
            <SearchIcon />
            <span className="text-[10px]">Search</span>
          </Link>
          <Link
            to="/compose"
            className="flex flex-1 flex-col items-center gap-0.5 py-2 text-accent active:opacity-70"
            aria-label="Compose"
          >
            <PencilIcon />
            <span className="text-[10px]">Compose</span>
          </Link>
        </nav>
      )}

      <FolderDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        accounts={accounts ?? []}
        selectedFolderId={folderId}
        onSelect={(f) => setParams({ folder: f.id })}
      />

      {menu &&
        (() => {
          const target = messages?.find((m) => m.id === menu.id);
          return target ? (
            <MessageContextMenu
              message={target}
              accounts={accounts ?? []}
              x={menu.x}
              y={menu.y}
              onClose={closeMenu}
              onToggleRead={handleToggleRead}
              onArchive={handleArchive}
              onDelete={handleDelete}
              onSelect={enterSelect}
            />
          ) : null;
        })()}
    </div>
  );
}
