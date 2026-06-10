/**
 * Cleanup drill-down screen (ROADMAP Phase 6b review + execute surface). A dedicated,
 * full-screen list of the individual messages a delete-eligible slice would trash for one
 * sender. Selectable: every message starts checked (the user's confirmed default), with a
 * Select all / Deselect all toggle and single-message toggling, so the user trashes exactly
 * what they choose — "Move selected to Trash" sends those ids, or "Trash all N from this
 * sender" scopes the whole sender server-side (no need to page through every message).
 *
 * Safety is server-side: the execute endpoint re-runs the same slice + HARD safety predicates
 * and intersects them with whatever scope we send, so a stale/protected id is silently dropped.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { CleanupExecuteRequest, CleanupMessageDto } from '@maily/shared';
import { api } from '../api/client';
import { Spinner } from '../ui/Spinner';
import { BackIcon, TrashIcon } from '../ui/icons';
import { CleanupMessageRow, SLICE_LABELS, formatBytes } from './Cleanup';

/** Messages fetched per page; "Load more" pulls the next page. */
const PAGE_SIZE = 100;

/** Delete-eligible slices that this drill-down can execute (backend DELETE_SLICES). */
const DELETE_ELIGIBLE = new Set([
  'never-replied',
  'cold-storage',
  'large',
  'unread',
  'newsletters',
]);

/** A positive number from a query param, or undefined (server defaults apply). */
function numParam(raw: string | null): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function CleanupMessages() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const slice = params.get('slice') ?? '';
  const domain = params.get('domain') ?? undefined;
  const years = numParam(params.get('years'));
  const minMb = numParam(params.get('minMb'));
  const months = numParam(params.get('months'));
  const actionable = DELETE_ELIGIBLE.has(slice);

  const [messages, setMessages] = useState<CleanupMessageDto[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);

  // Selection: ids currently checked. `autoSelectRef` keeps newly-loaded pages checked by default
  // (the all-pre-selected default) until the user explicitly deselects all. A ref (not state) so
  // `loadPage` reads the current value without being recreated on every selection change.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const autoSelectRef = useRef(true);

  // Execution lifecycle for the trash action: idle → running (queue draining) → done / error.
  const [exec, setExec] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [queued, setQueued] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(
    () => () => {
      if (pollRef.current) clearInterval(pollRef.current);
    },
    [],
  );

  // Fetch the page starting at `offset`; offset 0 replaces (initial / param change),
  // later pages append. Newly loaded ids join the selection while autoSelect holds.
  const loadPage = useCallback(
    async (offset: number) => {
      if (offset === 0) setLoading(true);
      else setLoadingMore(true);
      setError(false);
      try {
        const res = await api.cleanup.messages({
          slice,
          domain,
          years,
          minMb,
          months,
          limit: PAGE_SIZE,
          offset,
        });
        setMessages((prev) => (offset === 0 ? res.messages : [...prev, ...res.messages]));
        setTotal(res.total);
        setHasMore(res.truncated);
        setSelected((prev) => {
          const auto = autoSelectRef.current;
          if (offset === 0) return auto ? new Set(res.messages.map((m) => m.id)) : new Set();
          if (!auto) return prev;
          const next = new Set(prev);
          for (const m of res.messages) next.add(m.id);
          return next;
        });
      } catch {
        setError(true);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    // Reloads only when the slice/sender/thresholds change; autoSelect is read fresh inside.
    [slice, domain, years, minMb, months],
  );

  useEffect(() => {
    void loadPage(0);
  }, [loadPage]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectAll = () => {
    autoSelectRef.current = true;
    setSelected(new Set(messages.map((m) => m.id)));
  };
  const deselectAll = () => {
    autoSelectRef.current = false;
    setSelected(new Set());
  };

  const selectedBytes = messages.reduce((n, m) => (selected.has(m.id) ? n + m.bytes : n), 0);
  const allLoadedSelected = messages.length > 0 && selected.size === messages.length;

  // Kick off a trash run for the given scope, then poll the queue until it drains.
  async function runTrash(scope: Pick<CleanupExecuteRequest, 'messageIds' | 'domain'>) {
    setExec('running');
    try {
      const res = await api.cleanup.execute({
        slice: slice as CleanupExecuteRequest['slice'],
        years,
        minMb,
        months,
        ...scope,
      });
      setQueued(res.queued);
      pollRef.current = setInterval(() => {
        void api.cleanup
          .queueStatus()
          .then((status) => {
            if (status.pending === 0) {
              if (pollRef.current) clearInterval(pollRef.current);
              setExec('done');
            }
          })
          .catch(() => {
            /* transient — keep polling */
          });
      }, 2000);
    } catch {
      setExec('error');
    }
  }

  const title = domain || SLICE_LABELS[slice] || 'Messages';

  return (
    <div className="flex h-full flex-col">
      <header className="safe-top sticky top-0 z-10 flex items-center gap-1 border-b border-border bg-bg/85 px-2 py-2 backdrop-blur">
        <button
          onClick={() => navigate(-1)}
          className="rounded-full p-2 text-fg active:bg-surface-2"
          aria-label="Back"
        >
          <BackIcon />
        </button>
        <div className="min-w-0 flex-1 px-2">
          <h1 className="truncate text-lg font-semibold">{title}</h1>
          <p className="truncate text-xs text-faint">
            {SLICE_LABELS[slice] ?? 'Cleanup'}
            {!loading && ` · ${total.toLocaleString()} message${total === 1 ? '' : 's'}`}
          </p>
        </div>
        {actionable && !loading && messages.length > 0 && exec === 'idle' && (
          <button
            type="button"
            onClick={allLoadedSelected ? deselectAll : selectAll}
            className="shrink-0 rounded-full px-3 py-1.5 text-xs font-medium text-accent active:bg-surface-2"
          >
            {allLoadedSelected ? 'Deselect all' : 'Select all'}
          </button>
        )}
      </header>

      <main className="flex-1 overflow-y-auto no-scrollbar">
        {exec === 'done' ? (
          <div className="mx-auto max-w-2xl p-4 text-center">
            <p className="rounded-xl bg-surface-2 px-4 py-6 text-sm text-fg">
              Moved {queued.toLocaleString()} to Trash — recoverable there if you need them back.
            </p>
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="mt-4 rounded-full bg-accent px-5 py-2 text-sm font-medium text-white active:opacity-80"
            >
              Back to Cleanup
            </button>
          </div>
        ) : error && messages.length === 0 ? (
          <p className="px-4 py-8 text-center text-danger">Couldn’t load messages.</p>
        ) : loading ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : messages.length === 0 ? (
          <p className="px-4 py-8 text-center text-muted">No messages here.</p>
        ) : (
          <div className="mx-auto max-w-2xl p-3 pb-28">
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
              {messages.map((m) => (
                <li key={m.id}>
                  <CleanupMessageRow
                    m={m}
                    selectable={actionable && exec === 'idle'}
                    selected={selected.has(m.id)}
                    onToggle={() => toggle(m.id)}
                  />
                </li>
              ))}
            </ul>
            <p className="px-1 pt-3 text-center text-xs text-faint">
              Showing {messages.length.toLocaleString()} of {total.toLocaleString()}.
            </p>
            {hasMore && (
              <div className="flex justify-center pt-2">
                <button
                  type="button"
                  onClick={() => void loadPage(messages.length)}
                  disabled={loadingMore}
                  className="flex items-center gap-2 rounded-full border border-border bg-surface px-4 py-2 text-sm font-medium text-fg active:bg-surface-2 disabled:opacity-50"
                >
                  {loadingMore ? (
                    <Spinner />
                  ) : (
                    `Load ${Math.min(PAGE_SIZE, total - messages.length)} more`
                  )}
                </button>
              </div>
            )}
            {error && (
              <p className="px-1 pt-3 text-center text-xs text-danger">
                Couldn’t load more — try again.
              </p>
            )}
            {!actionable && (
              <p className="px-1 pb-4 pt-3 text-center text-xs text-faint">
                Tap a message to open it.
              </p>
            )}
          </div>
        )}
      </main>

      {/* Sticky action bar — selection-driven trashing for delete-eligible slices. */}
      {actionable && !loading && messages.length > 0 && exec !== 'done' && (
        <div className="safe-bottom sticky bottom-0 z-10 border-t border-border bg-bg/90 px-3 py-3 backdrop-blur">
          <div className="mx-auto max-w-2xl">
            {exec === 'running' ? (
              <div className="flex items-center justify-center gap-3 text-sm text-fg">
                <Spinner />
                <span>Moving {queued.toLocaleString()} to Trash…</span>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {exec === 'error' && (
                  <p className="text-center text-xs text-danger">
                    Couldn’t start cleanup — try again.
                  </p>
                )}
                <div className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 truncate text-sm text-muted">
                    {selected.size.toLocaleString()} selected
                    {selected.size > 0 && ` · ${formatBytes(selectedBytes)}`}
                  </span>
                  <button
                    type="button"
                    disabled={selected.size === 0}
                    onClick={() => void runTrash({ messageIds: [...selected] })}
                    className="flex shrink-0 items-center gap-2 rounded-full bg-accent px-4 py-2 text-sm font-medium text-white active:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <TrashIcon className="size-4" />
                    Move {selected.size > 0 ? `${selected.size.toLocaleString()} ` : ''}to Trash
                  </button>
                </div>
                {/* When the sender has more than this page, offer the whole-sender shortcut. */}
                {domain && total > messages.length && (
                  <button
                    type="button"
                    onClick={() => void runTrash({ domain })}
                    className="text-center text-xs font-medium text-faint underline-offset-2 active:text-muted hover:underline"
                  >
                    Trash all {total.toLocaleString()} from {domain}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
