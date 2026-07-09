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
import {
  deleteDrillState,
  drillStateKey,
  getDrillState,
  setDrillState,
} from '../state/cleanupDrill';
import { Spinner } from '../ui/Spinner';
import { BackIcon, SearchIcon, TrashIcon } from '../ui/icons';
import { CleanupMessageRow, SLICE_LABELS, formatBytes } from './Cleanup';

/** Messages fetched per page; "Load more" pulls the next page. */
const PAGE_SIZE = 100;

/**
 * Slices whose drill-down can execute a trash run (backend EXECUTE_SLICES). The delete-eligible
 * heuristics plus the unguarded `storage` audit — drilling a storage sender lets you trash that
 * sender's mail too (the backend resolves storage over live, Keep-honouring mail, no safety gate).
 */
const DELETE_ELIGIBLE = new Set(['storage', 'cold-storage', 'large', 'newsletters']);

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
  const actionable = DELETE_ELIGIBLE.has(slice);

  // Restore any in-progress selection/filter for this exact drill (state/cleanupDrill — the
  // session store that also feeds the sender list's "N/M marked" badges). Read once at mount
  // via the useState initialisers below; a fresh drill simply has no saved entry.
  const stateKey = drillStateKey({ slice, domain, years, minMb });
  const saved = getDrillState(stateKey);
  const restoredRef = useRef(saved != null);

  const [messages, setMessages] = useState<CleanupMessageDto[]>([]);
  const [total, setTotal] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);

  // Subject/sender filter — debounced so each keystroke doesn't refetch. The whole-sender
  // express path is hidden while a filter is active (it would trash beyond what's shown).
  const [q, setQ] = useState(saved?.q ?? '');
  const [qDebounced, setQDebounced] = useState(saved?.q ?? '');
  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  // Selection model. Two modes so "select all" can mean the WHOLE slice, not just the loaded
  // page — the point of the server's `excludeMessageIds`:
  //  - 'all'    : every matching message is selected; `excluded` holds the few the user unchecked.
  //               With no search filter this trashes the whole (optionally sender-scoped) slice
  //               minus `excluded` in one call — no need to page through thousands.
  //  - 'manual' : nothing is selected by default; `included` holds the messages the user picked.
  // A search filter (`q`) forces explicit ids regardless of mode — the whole-slice express can't
  // express "matching the filter", so we only ever trash the loaded+checked rows while filtering.
  const [mode, setMode] = useState<'all' | 'manual'>(saved?.mode ?? 'all');
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set(saved?.excluded));
  const [included, setIncluded] = useState<Set<string>>(() => new Set(saved?.included));

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

  // The most recent "keep" (per-row shield) is held briefly so a misclick is reversible:
  // the shield is a one-tap action with no confirm, so without this a mistap silently
  // protects a message with no obvious way back. Stores the removed row + its position
  // so Undo restores it exactly where it was and releases the keep server-side.
  const [keptUndo, setKeptUndo] = useState<{ message: CleanupMessageDto; index: number } | null>(
    null,
  );
  const keptTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (keptTimer.current) clearTimeout(keptTimer.current);
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
          q: qDebounced || undefined,
          years,
          minMb,
          limit: PAGE_SIZE,
          offset,
        });
        setMessages((prev) => (offset === 0 ? res.messages : [...prev, ...res.messages]));
        setTotal(res.total);
        setTotalBytes(res.totalBytes);
        setHasMore(res.truncated);
        // A fresh load (slice/sender/thresholds/search change) returns to the all-selected
        // default; appended pages inherit the mode (no per-page bookkeeping — 'all' covers new
        // rows implicitly, 'manual' leaves them unchecked). The exception is the very first
        // load after remounting onto a restored drill — there we keep the saved selection.
        if (offset === 0) {
          if (restoredRef.current) {
            restoredRef.current = false;
          } else {
            setMode('all');
            setExcluded(new Set());
            setIncluded(new Set());
          }
        }
      } catch {
        setError(true);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    // Reloads when the slice/sender/thresholds/search change; autoSelect is read fresh inside.
    [slice, domain, qDebounced, years, minMb],
  );

  useEffect(() => {
    void loadPage(0);
  }, [loadPage]);

  // A message is checked iff it's not excluded ('all' mode) or explicitly included ('manual').
  const isChecked = (id: string) => (mode === 'all' ? !excluded.has(id) : included.has(id));

  const toggle = (id: string) => {
    const set = mode === 'all' ? excluded : included;
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    (mode === 'all' ? setExcluded : setIncluded)(next);
  };

  const selectAll = () => {
    setMode('all');
    setExcluded(new Set());
  };
  const deselectAll = () => {
    setMode('manual');
    setIncluded(new Set());
  };

  // Persist the in-progress selection/filter so tapping into a message and coming back keeps it.
  // Only while reviewing (actionable + idle); once a trash run finishes the saved state is stale,
  // so drop it (a later revisit of the same sender starts fresh from the server's new totals).
  // The pristine default (everything checked, no filter) carries no information, so it clears
  // the saved state instead — "Select all" doubles as "discard my review", and merely opening a
  // sender never leaves a "N/N marked" badge behind.
  useEffect(() => {
    if (!actionable) return;
    if (exec === 'done' || (mode === 'all' && excluded.size === 0 && !q)) {
      deleteDrillState(stateKey);
      return;
    }
    setDrillState(stateKey, {
      q,
      mode,
      excluded: [...excluded],
      included: [...included],
      excludedBytes: messages.reduce((n, m) => (excluded.has(m.id) ? n + m.bytes : n), 0),
      includedBytes: messages.reduce((n, m) => (included.has(m.id) ? n + m.bytes : n), 0),
    });
  }, [actionable, exec, stateKey, q, mode, excluded, included, messages]);

  // Whether the whole-slice express path applies: 'all' mode and no active search filter. Then
  // "select all" really means every match (incl. unloaded pages), trashed via `excludeMessageIds`.
  const qActive = qDebounced.length > 0;
  const express = mode === 'all' && !qActive;

  // Loaded rows currently checked — the explicit-id set used when not in express mode.
  const checkedLoaded = messages.filter((m) => isChecked(m.id));
  const excludedLoadedBytes = messages.reduce(
    (n, m) => (mode === 'all' && excluded.has(m.id) ? n + m.bytes : n),
    0,
  );

  // What a trash run would move + its estimated bytes (whole match in express mode, else loaded).
  const trashCount = express ? Math.max(0, total - excluded.size) : checkedLoaded.length;
  const trashBytes = express
    ? Math.max(0, totalBytes - excludedLoadedBytes)
    : checkedLoaded.reduce((n, m) => n + m.bytes, 0);

  const allChecked =
    mode === 'all' ? excluded.size === 0 : messages.length > 0 && included.size === messages.length;

  // Preserve a message from cleanup (the per-row shield): mark it kept server-side, then drop it
  // from the list optimistically (it's no longer a cleanup candidate). On failure, reload.
  // Arms a short undo window (below) so a mistapped shield is recoverable.
  const keepMessage = (id: string) => {
    const index = messages.findIndex((m) => m.id === id);
    if (index === -1) return;
    const message = messages[index]!;
    setMessages((prev) => prev.filter((m) => m.id !== id));
    setTotal((t) => Math.max(0, t - 1));
    setTotalBytes((b) => Math.max(0, b - message.bytes));
    setExcluded((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setIncluded((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    void api.cleanup.keep([id], true).catch(() => void loadPage(0));
    if (keptTimer.current) clearTimeout(keptTimer.current);
    setKeptUndo({ message, index });
    keptTimer.current = setTimeout(() => setKeptUndo(null), 6000);
  };

  // Reverse the last keep: release it server-side and slot the row back where it was.
  const undoKeep = () => {
    if (!keptUndo) return;
    if (keptTimer.current) clearTimeout(keptTimer.current);
    const { message, index } = keptUndo;
    setKeptUndo(null);
    void api.cleanup.keep([message.id], false).catch(() => void loadPage(0));
    setMessages((prev) => {
      if (prev.some((m) => m.id === message.id)) return prev;
      const next = prev.slice();
      next.splice(Math.min(index, next.length), 0, message);
      return next;
    });
    setTotal((t) => t + 1);
    setTotalBytes((b) => b + message.bytes);
  };

  // Kick off a trash run for the current selection, then poll the queue until it drains. In
  // express mode the scope is the whole (optionally sender-scoped) slice minus `excluded`;
  // otherwise it's the explicit checked-and-loaded ids. The server re-validates either way.
  async function runTrash() {
    const scope: Pick<CleanupExecuteRequest, 'messageIds' | 'domain' | 'excludeMessageIds'> =
      express
        ? { domain, excludeMessageIds: excluded.size ? [...excluded] : undefined }
        : { messageIds: checkedLoaded.map((m) => m.id) };
    setExec('running');
    try {
      const res = await api.cleanup.execute({
        slice: slice as CleanupExecuteRequest['slice'],
        years,
        minMb,
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
  // The selection-driven trash action bar; the keep-undo toast sits just above it when shown.
  const showActionBar = actionable && !loading && messages.length > 0 && exec !== 'done';

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
            onClick={allChecked ? deselectAll : selectAll}
            className="shrink-0 rounded-full px-3 py-1.5 text-xs font-medium text-accent active:bg-surface-2"
          >
            {allChecked ? 'Deselect all' : 'Select all'}
          </button>
        )}
      </header>

      <main className="flex-1 overflow-y-auto no-scrollbar">
        {/* Outside the list conditional so the input survives (and keeps focus through) refetches. */}
        {exec !== 'done' && (
          <div className="mx-auto max-w-2xl px-3 pt-3">
            <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2">
              <SearchIcon className="size-4 shrink-0 text-faint" />
              <input
                type="search"
                inputMode="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Filter by subject or sender…"
                className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-faint"
              />
            </div>
          </div>
        )}
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
          <p className="px-4 py-8 text-center text-muted">
            {qDebounced ? 'No messages match the filter.' : 'No messages here.'}
          </p>
        ) : (
          <div className="mx-auto max-w-2xl p-3 pb-28">
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
              {messages.map((m) => (
                <li key={m.id}>
                  <CleanupMessageRow
                    m={m}
                    selectable={actionable && exec === 'idle'}
                    selected={isChecked(m.id)}
                    onToggle={() => toggle(m.id)}
                    onKeep={actionable && exec === 'idle' ? () => keepMessage(m.id) : undefined}
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

      {/* Undo window for the per-row "Keep" shield — a mistap is otherwise irreversible.
          Sits above the action bar when it's showing, else near the bottom edge. */}
      {keptUndo && (
        <div
          className={`safe-bottom pointer-events-none fixed inset-x-0 z-50 flex justify-center px-4 ${
            showActionBar ? 'bottom-24' : 'bottom-4'
          }`}
        >
          <div className="pointer-events-auto flex items-center gap-4 rounded-full border border-border bg-surface-2 py-2.5 pl-4 pr-2.5 text-sm shadow-lg">
            <span className="text-fg">Kept — excluded from cleanup</span>
            <button
              type="button"
              onClick={undoKeep}
              className="rounded-full px-3 py-1 font-medium text-accent active:bg-surface-3"
            >
              Undo
            </button>
          </div>
        </div>
      )}

      {/* Sticky action bar — selection-driven trashing for delete-eligible slices. */}
      {showActionBar && (
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
                    {trashCount.toLocaleString()} selected
                    {trashCount > 0 && ` · ${formatBytes(trashBytes)}`}
                  </span>
                  <button
                    type="button"
                    disabled={trashCount === 0}
                    onClick={() => void runTrash()}
                    className="flex shrink-0 items-center gap-2 rounded-full bg-accent px-4 py-2 text-sm font-medium text-white active:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <TrashIcon className="size-4" />
                    Move {trashCount > 0 ? `${trashCount.toLocaleString()} ` : ''}to Trash
                  </button>
                </div>
                {/* In express mode "select all" reaches beyond the loaded page — make that explicit
                    so a one-tap trash of thousands is never a surprise. */}
                {express && total > messages.length && (
                  <p className="text-center text-xs text-faint">
                    Selecting all {total.toLocaleString()}
                    {domain ? ` from ${domain}` : ' in this slice'} — including{' '}
                    {(total - messages.length).toLocaleString()} not shown.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
