/**
 * Cleanup Dashboard (ROADMAP Phase 6 "Master archive & Cleanup Dashboard"). An opt-in
 * power tool over the local SQLite archive — *not* a backlog to clear. It previews the
 * impact (message count + estimated storage, grouped by sender — domain, or full address
 * for freemail providers) of deterministic
 * cleanup slices — several *angles* on deletable mail (size, age, attention, sender
 * behaviour, bulk-mail markers) — then executes them with an explicit include/select model:
 *
 *  - **Move all N to Trash…** — a one-tap express path that trashes the whole server-resolved
 *    slice (no truncation pretense: the count is the true total, not the 50 shown).
 *  - **Review all N… / Review by sender** — navigation-only paths into the drill-down screen
 *    where individual messages are inspected, selected (default all) and trashed.
 *
 * Execution is Trash-only and recoverable: the server re-validates the HARD safety gate
 * (financial / legal / account / medical mail is protected) and **intersects** any client
 * selection with the eligible set, tombstones, and a rate-limited background queue MOVEs them
 * to Trash — never EXPUNGE. The dashboard shows the "Moving N to Trash…" progress until the
 * queue drains.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type {
  CleanupDashboardDto,
  CleanupGroupDto,
  CleanupMessageDto,
  CleanupSliceDto,
} from '@maily/shared';
import { api, type GroupSort } from '../api/client';
import { getPrefs, setPref, usePrefs, type Prefs } from '../state/prefs';
import { cachedDashboard, loadDashboard } from '../state/cleanupDash';
import {
  drillMarkedCount,
  drillStateKey,
  getBrowserState,
  setBrowserState,
} from '../state/cleanupDrill';
import {
  enabledSlices,
  SLICE_ORDER,
  type ActionSlice,
  type SliceParams,
} from '../state/cleanupConfig';
import { Spinner } from '../ui/Spinner';
import {
  BackIcon,
  ChevronDownIcon,
  CloseIcon,
  MailOpenIcon,
  PlusIcon,
  SearchIcon,
  ShieldIcon,
  SparklesIcon,
  TrashIcon,
} from '../ui/icons';

export type { SliceParams } from '../state/cleanupConfig';

/** Human-readable byte size (1 KB = 1024 B). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || Number.isInteger(v) ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Human slice labels, shared with the dedicated drill-down screen. */
export const SLICE_LABELS: Record<string, string> = {
  storage: 'Storage by sender',
  'cold-storage': 'Cold storage',
  large: 'Large messages',
  newsletters: 'Newsletters & bulk mail',
};

/** Compact absolute date for a message row, e.g. "3 May 2024". */
export function formatMsgDate(iso: string | null): string {
  if (!iso) return 'unknown date';
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * One drill-down message row — subject + sender/date + size. Shared by the dedicated
 * drill-down screen. When `selectable`, a leading checkbox reflects/toggles selection and the
 * row's checkbox toggles selection, but a trailing "open" button still deep-links to the
 * reader so the actual email (body, attachments) can be inspected when subject + sender
 * aren't enough to judge it; otherwise the whole row deep-links to the reader. When `onKeep`
 * is given, a trailing shield button preserves the message from cleanup.
 */
export function CleanupMessageRow({
  m,
  selectable = false,
  selected = false,
  onToggle,
  onKeep,
  onUnkeep,
}: {
  m: CleanupMessageDto;
  selectable?: boolean;
  selected?: boolean;
  onToggle?: () => void;
  onKeep?: () => void;
  /** Release a guarded message back into cleanup (the "Guarded mail" section's action). */
  onUnkeep?: () => void;
}) {
  const body = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-fg">{m.subject || '(no subject)'}</span>
        <span className="block truncate text-xs text-faint">
          {(m.fromName || m.fromAddress || 'Unknown sender') + ' · ' + formatMsgDate(m.receivedAt)}
        </span>
      </span>
      <span className="shrink-0 text-xs tabular-nums text-faint">{formatBytes(m.bytes)}</span>
    </>
  );

  const keepButton = onKeep && (
    <button
      type="button"
      onClick={onKeep}
      aria-label="Keep — never clean up"
      title="Keep — exclude from cleanup"
      className="shrink-0 rounded-full p-2 text-faint active:bg-surface-2 active:text-accent"
    >
      <ShieldIcon className="size-5" />
    </button>
  );

  const unkeepButton = onUnkeep && (
    <button
      type="button"
      onClick={onUnkeep}
      aria-label="Stop guarding — allow cleanup"
      title="Stop guarding — allow cleanup"
      className="shrink-0 rounded-full p-2 text-accent active:bg-surface-2"
    >
      <ShieldIcon className="size-5" />
    </button>
  );

  if (selectable) {
    return (
      <div className="flex w-full items-center active:bg-surface-2">
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-3 py-2 pl-3 text-left"
          aria-pressed={selected}
        >
          <input
            type="checkbox"
            checked={selected}
            readOnly
            tabIndex={-1}
            aria-hidden
            className="size-4 shrink-0 accent-accent"
          />
          {body}
        </button>
        {/* Open the real email — subject + sender alone often aren't enough to judge a
            large attachment, so this deep-links into the reader without toggling selection. */}
        <Link
          to={`/m/${m.id}`}
          aria-label="Open message"
          title="Open message"
          className="shrink-0 rounded-full p-2 text-faint active:bg-surface-2 active:text-accent"
        >
          <MailOpenIcon className="size-5" />
        </Link>
        {keepButton ?? <span className="pr-3" />}
      </div>
    );
  }

  if (unkeepButton) {
    return (
      <div className="flex w-full items-center active:bg-surface-2">
        <Link to={`/m/${m.id}`} className="flex min-w-0 flex-1 items-center gap-3 py-2 pl-3">
          {body}
        </Link>
        {unkeepButton}
      </div>
    );
  }

  return (
    <Link to={`/m/${m.id}`} className="flex items-center gap-3 px-3 py-2 active:bg-surface-2">
      {body}
    </Link>
  );
}

/** What a {@link SenderBrowser} lists, and (for action slices) where a sender row drills to. */
type BrowseSource = { slice: 'storage' | ActionSlice; params?: SliceParams };

/** Build the drill-down URL query for a slice (+ optional sender), carrying its thresholds. */
export function drillQuery(
  slice: ActionSlice | 'storage',
  params: SliceParams = {},
  domain?: string,
): string {
  const p = new URLSearchParams({ slice });
  if (domain) p.set('domain', domain);
  if (params.years) p.set('years', String(params.years));
  if (params.minMb) p.set('minMb', String(params.minMb));
  return p.toString();
}

/**
 * Collapsible "Review by sender" — a searchable, paginated per-domain list. Owns its own
 * fetching so it can page the long tail (Load more) and filter by a domain substring (the
 * search box) without re-rendering the whole dashboard. Each row drills into the message
 * drill-down (where messages are selected + trashed).
 *
 * For the unguarded `storage` audit the list is also **multi-select**: each row gets a
 * checkbox, and the selected senders can be trashed in one confirmed run (`onExecuted` lets
 * the dashboard refresh once the queue drains). Selecting reaches every message from those
 * senders — what the audit shows minus Keep-flagged mail — without paging through them.
 */
function SenderBrowser({ source, onExecuted }: { source: BrowseSource; onExecuted?: () => void }) {
  const navigate = useNavigate();
  // The browser's UI state survives navigation (session-lived): drilling into a sender and
  // coming back must land on the open list you left, not a collapsed card (state/cleanupDrill).
  const browserKey = drillStateKey({ slice: source.slice, ...source.params });
  const savedUi = getBrowserState(browserKey);
  const [open, setOpen] = useState(savedUi?.open ?? false);
  const [q, setQ] = useState(savedUi?.q ?? '');
  // Sort + minimum-threshold filters for the sender list (applied server-side over the whole
  // slice, not just the loaded page). Empty inputs = no minimum. Defaults to sorting by
  // message count — reviewing "who sends the most" reads better than raw bytes first.
  const [sort, setSort] = useState<GroupSort>(savedUi?.sort ?? 'count');
  const [minMsgs, setMinMsgs] = useState(savedUi?.minMsgs ?? '');
  const [minSizeMb, setMinSizeMb] = useState(savedUi?.minSizeMb ?? '');
  const [groups, setGroups] = useState<CleanupGroupDto[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);

  const kind = source.slice;
  const { years, minMb } = source.params ?? {};
  const minMsgsNum = Number(minMsgs) > 0 ? Math.floor(Number(minMsgs)) : undefined;
  const minSizeMbNum = Number(minSizeMb) > 0 ? Number(minSizeMb) : undefined;

  // Mirror the UI state into the session store on every change (cheap, keyed writes).
  useEffect(() => {
    setBrowserState(browserKey, { open, q, sort, minMsgs, minSizeMb });
  }, [browserKey, open, q, sort, minMsgs, minSizeMb]);

  // Multi-select trash, storage-only: the audit has no safety gate, so a row checkbox can scope
  // a whole-sender (or many-sender) trash run. `selected` holds the chosen sender keys; the
  // trash lifecycle mirrors ActionSliceCard (idle → confirm → running → done/error).
  const selectable = kind === 'storage';
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exec, setExec] = useState<'idle' | 'confirm' | 'running' | 'done' | 'error'>('idle');
  const [queued, setQueued] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(
    () => () => {
      if (pollRef.current) clearInterval(pollRef.current);
    },
    [],
  );

  const fetchPage = useCallback(
    (opts: { offset?: number }): Promise<CleanupSliceDto> => {
      const o = {
        q: q || undefined,
        sort,
        minMsgs: minMsgsNum,
        minSizeMb: minSizeMbNum,
        offset: opts.offset,
      };
      switch (kind) {
        case 'storage':
          return api.cleanup.storage(o);
        case 'cold-storage':
          return api.cleanup.coldStorage(years, o);
        case 'large':
          return api.cleanup.large(minMb, o);
        case 'newsletters':
          return api.cleanup.newsletters(o);
      }
    },
    [kind, years, minMb, q, sort, minMsgsNum, minSizeMbNum],
  );

  // (Re)load the first page when opened or any of the (debounced) search/sort/filter inputs
  // change. The debounce mainly absorbs typing in the text fields; discrete controls reload too.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    const t = setTimeout(
      () => {
        fetchPage({})
          .then((res) => {
            if (cancelled) return;
            setGroups(res.groups);
            setHasMore(res.truncated);
            // A fresh list (search/sort/filter changed, or just opened) drops any selection —
            // it could otherwise point at senders the new filter no longer shows.
            setSelected(new Set());
            setExec('idle');
          })
          .catch(() => {
            if (!cancelled) setError(true);
          })
          .finally(() => {
            if (!cancelled) setLoading(false);
          });
      },
      // Debounce only while the text fields are being typed; the first open + the discrete
      // sort/threshold controls fetch immediately.
      q || minMsgs || minSizeMb ? 250 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, fetchPage]);

  const loadMore = () => {
    setLoadingMore(true);
    setError(false);
    fetchPage({ offset: groups.length })
      .then((res) => {
        setGroups((prev) => [...prev, ...res.groups]);
        setHasMore(res.truncated);
      })
      .catch(() => setError(true))
      .finally(() => setLoadingMore(false));
  };

  // Every sender row drills down to its per-sender message list — where individual messages can
  // be inspected and (for delete-eligible slices and the storage audit) trashed.
  const drillInto = (domain: string) => {
    navigate(`/cleanup/messages?${drillQuery(kind, source.params, domain)}`);
  };

  // Multi-select (storage) — toggle one sender, and the running totals of the selection. Counts
  // are summed over the loaded rows (you can only select what's visible), so they reflect exactly
  // the senders chosen; the server re-resolves the actual eligible set on execute.
  const toggleSelect = (domain: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(domain)) next.delete(domain);
      else next.add(domain);
      return next;
    });
    if (exec !== 'idle') setExec('idle');
  };
  const selectedGroups = groups.filter((g) => selected.has(g.domain));
  const selCount = selectedGroups.reduce((n, g) => n + g.messageCount, 0);
  const selBytes = selectedGroups.reduce((n, g) => n + g.bytes, 0);

  // Trash every message from the selected senders (storage's unguarded path: no safety gate, but
  // Keep-flagged mail is still spared server-side). Polls the global queue until it drains, then
  // refreshes the dashboard and reloads this list so the trashed senders drop away.
  async function trashSelected() {
    if (selected.size === 0) return;
    setExec('running');
    try {
      const res = await api.cleanup.execute({ slice: 'storage', domains: [...selected] });
      setQueued(res.queued);
      pollRef.current = setInterval(() => {
        void api.cleanup
          .queueStatus()
          .then((status) => {
            if (status.pending === 0) {
              if (pollRef.current) clearInterval(pollRef.current);
              setExec('done');
              setSelected(new Set());
              onExecuted?.();
              void fetchPage({}).then((r) => {
                setGroups(r.groups);
                setHasMore(r.truncated);
              });
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

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="text-sm font-medium text-accent active:opacity-80"
      >
        {open ? 'Hide senders ▴' : 'Review by sender ▾'}
      </button>

      {open && (
        <div className="mt-2">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2">
            <SearchIcon className="size-4 shrink-0 text-faint" />
            <input
              type="search"
              inputMode="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search senders…"
              className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-faint"
            />
          </div>

          {/* Sort + minimum-threshold filters — applied over the whole slice, not the page. */}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
            <label className="flex items-center gap-1.5">
              <span>Sort</span>
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as GroupSort)}
                className="rounded-lg border border-border bg-surface px-2 py-1 text-fg outline-none focus:border-accent"
              >
                <option value="bytes">Size</option>
                <option value="count">Messages</option>
                <option value="name">Name</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              <span>≥</span>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                value={minMsgs}
                onChange={(e) => setMinMsgs(e.target.value)}
                placeholder="0"
                className="w-14 rounded-lg border border-border bg-surface px-2 py-1 text-right tabular-nums text-fg outline-none focus:border-accent"
              />
              <span>msg</span>
            </label>
            <label className="flex items-center gap-1.5">
              <span>≥</span>
              <input
                type="number"
                inputMode="decimal"
                min={0}
                step="0.1"
                value={minSizeMb}
                onChange={(e) => setMinSizeMb(e.target.value)}
                placeholder="0"
                className="w-14 rounded-lg border border-border bg-surface px-2 py-1 text-right tabular-nums text-fg outline-none focus:border-accent"
              />
              <span>MB</span>
            </label>
          </div>

          {loading ? (
            <div className="flex justify-center py-6">
              <Spinner />
            </div>
          ) : error && groups.length === 0 ? (
            <p className="px-1 py-3 text-center text-sm text-danger">Couldn’t load senders.</p>
          ) : groups.length === 0 ? (
            <p className="px-1 py-3 text-center text-sm text-muted">
              {q || minMsgsNum || minSizeMbNum
                ? 'No senders match.'
                : 'Nothing here — nice and tidy.'}
            </p>
          ) : (
            <>
              {/* Storage multi-select hint + a quick select-all/clear for the loaded rows. */}
              {selectable && (
                <div className="mt-2 flex items-center justify-between gap-2 px-1 text-xs text-muted">
                  <span>Tick senders to trash; tap a name to review first.</span>
                  <button
                    type="button"
                    onClick={() =>
                      setSelected(
                        selected.size === groups.length
                          ? new Set()
                          : new Set(groups.map((g) => g.domain)),
                      )
                    }
                    className="shrink-0 font-medium text-accent active:opacity-80"
                  >
                    {selected.size === groups.length ? 'Clear' : 'Select all'}
                  </button>
                </div>
              )}
              <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
                {groups.map((g) => {
                  // In-progress drill review for this sender → a "19/21 marked" badge, so
                  // hopping between senders keeps the review progress visible.
                  const marked = drillMarkedCount(
                    drillStateKey({ slice: kind, ...source.params, domain: g.domain }),
                    g.messageCount,
                  );
                  return (
                    <li key={g.domain} className="flex w-full items-center active:bg-surface-2">
                      {selectable && (
                        <button
                          type="button"
                          onClick={() => toggleSelect(g.domain)}
                          aria-label={`Select ${g.domain}`}
                          aria-pressed={selected.has(g.domain)}
                          className="shrink-0 py-2 pl-3 pr-1"
                        >
                          <input
                            type="checkbox"
                            checked={selected.has(g.domain)}
                            readOnly
                            tabIndex={-1}
                            aria-hidden
                            className="size-4 accent-accent"
                          />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => drillInto(g.domain)}
                        aria-label={`Review messages from ${g.domain}`}
                        className={`flex min-w-0 flex-1 items-center gap-3 py-2 pr-3 text-left text-sm ${selectable ? 'pl-1' : 'pl-3'}`}
                      >
                        <span className="min-w-0 flex-1 truncate text-fg">{g.domain}</span>
                        {/* The badge subsumes the msg count (marked/total) — swapping, not
                            stacking, keeps the sender name readable on narrow screens. */}
                        {marked !== null ? (
                          <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium tabular-nums text-accent">
                            {marked}/{g.messageCount} marked
                          </span>
                        ) : (
                          <span className="shrink-0 tabular-nums text-muted">
                            {g.messageCount} msg
                          </span>
                        )}
                        <span className="w-20 shrink-0 text-right tabular-nums text-faint">
                          {formatBytes(g.bytes)}
                        </span>
                        <ChevronDownIcon className="size-4 shrink-0 -rotate-90 text-faint" />
                      </button>
                    </li>
                  );
                })}
              </ul>
              {hasMore && (
                <div className="flex justify-center pt-2">
                  <button
                    type="button"
                    onClick={loadMore}
                    disabled={loadingMore}
                    className="flex items-center gap-2 rounded-full border border-border bg-surface px-4 py-1.5 text-sm font-medium text-fg active:bg-surface-2 disabled:opacity-50"
                  >
                    {loadingMore ? <Spinner /> : 'Load more senders'}
                  </button>
                </div>
              )}
              {error && groups.length > 0 && (
                <p className="px-1 pt-2 text-center text-xs text-danger">
                  Couldn’t load more — try again.
                </p>
              )}

              {/* Storage multi-select trash bar — appears once a sender is ticked, with an
                  explicit confirm step before the (unguarded, Keep-honouring) trash run. */}
              {selectable && (selected.size > 0 || exec === 'running' || exec === 'done') && (
                <div className="mt-3 rounded-lg border border-border bg-surface-2 p-3">
                  {exec === 'done' ? (
                    <p className="text-sm text-fg">
                      Moved {queued.toLocaleString()} to Trash — recoverable there if you need them
                      back.
                    </p>
                  ) : exec === 'running' ? (
                    <div className="flex items-center gap-3 text-sm text-fg">
                      <Spinner />
                      <span>Moving {(queued || selCount).toLocaleString()} to Trash…</span>
                    </div>
                  ) : exec === 'confirm' ? (
                    <>
                      <p className="text-sm text-fg">
                        Move all <span className="font-medium">{selCount.toLocaleString()}</span>{' '}
                        message{selCount === 1 ? '' : 's'} from{' '}
                        <span className="font-medium">{selected.size.toLocaleString()}</span> sender
                        {selected.size === 1 ? '' : 's'} to Trash and free{' '}
                        <span className="font-medium">{formatBytes(selBytes)}</span>? They’re
                        recoverable from Trash. Mail you’ve marked Keep is spared.
                      </p>
                      <div className="mt-3 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void trashSelected()}
                          className="flex items-center gap-2 rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-white active:opacity-80"
                        >
                          <TrashIcon className="size-4" />
                          Move to Trash
                        </button>
                        <button
                          type="button"
                          onClick={() => setExec('idle')}
                          className="rounded-full px-4 py-1.5 text-sm font-medium text-muted active:bg-surface-3"
                        >
                          Cancel
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="flex items-center gap-3">
                      <span className="min-w-0 flex-1 text-sm text-fg">
                        {selected.size.toLocaleString()} sender{selected.size === 1 ? '' : 's'} ·{' '}
                        {selCount.toLocaleString()} msg · {formatBytes(selBytes)}
                      </span>
                      {exec === 'error' && (
                        <span className="shrink-0 text-xs text-danger">Failed — retry</span>
                      )}
                      <button
                        type="button"
                        onClick={() => setExec('confirm')}
                        className="flex shrink-0 items-center gap-2 rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-white active:opacity-80"
                      >
                        <TrashIcon className="size-4" />
                        Trash…
                      </button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The storage-audit card. Informational at heart (it shows where space goes, with no safety
 * gate), but its sender list is multi-select: ticked senders can be trashed in one confirmed
 * run. `onExecuted` refreshes the dashboard totals once that run's queue drains.
 */
function InfoSliceCard({
  title,
  description,
  slice,
  onExecuted,
}: {
  title: string;
  description: string;
  slice: CleanupSliceDto | null;
  onExecuted: () => void;
}) {
  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold text-fg">{title}</h2>
        {slice && (
          <span className="shrink-0 text-sm tabular-nums text-muted">
            {slice.totalMessages.toLocaleString()} msg · {formatBytes(slice.totalBytes)}
          </span>
        )}
      </div>
      <p className="mt-1 text-sm text-muted">{description}</p>
      {slice === null ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : (
        <SenderBrowser source={{ slice: 'storage' }} onExecuted={onExecuted} />
      )}
    </section>
  );
}

/**
 * A delete-eligible slice card. Three explicit affordances, each named for what it does:
 *  - **Review all N…** — navigates to the full drill-down (inspect / pick individual
 *    messages across the whole slice). Never deletes anything by itself.
 *  - **Review by sender** — the collapsible per-domain browser; a sender row drills down.
 *  - **Move all N to Trash…** — the express path; the trailing ellipsis signals a confirm
 *    step before the server-resolved slice is queued for trashing.
 * `onExecuted` lets the parent refresh totals once the queue drains.
 */
function ActionSliceCard({
  title,
  description,
  sliceId,
  slice,
  params,
  onExecuted,
  footer,
}: {
  title: string;
  description: string;
  sliceId: ActionSlice;
  slice: CleanupSliceDto | null;
  params?: SliceParams;
  onExecuted: () => void;
  /** Extra controls rendered at the bottom of the card (e.g. a keyword editor). */
  footer?: React.ReactNode;
}) {
  const navigate = useNavigate();
  const [mode, setMode] = useState<'idle' | 'confirm' | 'running' | 'done' | 'error'>('idle');
  const [queued, setQueued] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(
    () => () => {
      if (pollRef.current) clearInterval(pollRef.current);
    },
    [],
  );

  async function execute() {
    if (!slice) return;
    setMode('running');
    try {
      const res = await api.cleanup.execute({ slice: sliceId, ...params });
      setQueued(res.queued);
      // Poll the global trash queue until it drains, then refresh the dashboard totals.
      pollRef.current = setInterval(() => {
        void api.cleanup
          .queueStatus()
          .then((status) => {
            if (status.pending === 0) {
              if (pollRef.current) clearInterval(pollRef.current);
              setMode('done');
              onExecuted();
            }
          })
          .catch(() => {
            /* transient — keep polling */
          });
      }, 2000);
    } catch {
      setMode('error');
    }
  }

  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold text-fg">{title}</h2>
        {slice && (
          <span className="shrink-0 text-sm tabular-nums text-muted">
            {slice.totalMessages.toLocaleString()} msg · {formatBytes(slice.totalBytes)}
          </span>
        )}
      </div>
      <p className="mt-1 text-sm text-muted">{description}</p>

      {slice === null ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : slice.totalMessages === 0 ? (
        <p className="px-1 py-2 text-sm text-muted">Nothing here — nice and tidy.</p>
      ) : mode === 'done' ? (
        <p className="mt-3 rounded-lg bg-surface-2 px-3 py-2 text-sm text-fg">
          Moved {queued.toLocaleString()} to Trash — recoverable there if you need them back.
        </p>
      ) : mode === 'running' ? (
        <div className="mt-3 flex items-center gap-3 rounded-lg bg-surface-2 px-3 py-2 text-sm text-fg">
          <Spinner />
          <span>Moving {(queued || slice.totalMessages).toLocaleString()} to Trash…</span>
        </div>
      ) : mode === 'idle' ? (
        <>
          <div className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-surface-2 px-3 py-2">
            <span className="text-sm text-fg">
              {slice.totalMessages.toLocaleString()} messages · free{' '}
              <span className="font-medium">{formatBytes(slice.totalBytes)}</span>
            </span>
            <button
              type="button"
              onClick={() => setMode('confirm')}
              className="shrink-0 rounded-full bg-accent px-3 py-1 text-xs font-medium text-white active:opacity-80"
            >
              Move all to Trash…
            </button>
          </div>
          {/* Review paths — navigation only, nothing is deleted from here. */}
          <button
            type="button"
            onClick={() => navigate(`/cleanup/messages?${drillQuery(sliceId, params)}`)}
            className="mt-3 block text-sm font-medium text-accent active:opacity-80"
          >
            Review all {slice.totalMessages.toLocaleString()} messages ›
          </button>
          <SenderBrowser source={{ slice: sliceId, params }} />
        </>
      ) : (
        // confirm / error
        <>
          {mode === 'error' && (
            <p className="mt-3 text-sm text-danger">Couldn’t start cleanup — try again.</p>
          )}
          <p className="mt-3 text-sm text-fg">
            Move all <span className="font-medium">{slice.totalMessages.toLocaleString()}</span> to
            Trash and free <span className="font-medium">{formatBytes(slice.totalBytes)}</span>?
            They’re recoverable from Trash. To spare some, cancel and review the messages first.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void execute()}
              className="rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-white active:opacity-80"
            >
              Move all to Trash
            </button>
            <button
              type="button"
              onClick={() => setMode('idle')}
              className="rounded-full px-4 py-1.5 text-sm font-medium text-muted active:bg-surface-2"
            >
              Cancel
            </button>
          </div>
        </>
      )}
      {footer}
    </section>
  );
}

/**
 * Built-in protected-safety words shown (read-only) in the "Protected mail" editor — mirrors the
 * backend's PROTECTED_KEYWORDS (cleanup/keywords.ts). Display only: the real gate is server-side,
 * so this list is for context; the user's additions are what's editable.
 */
const PROTECTED_BUILTINS = [
  'invoice',
  'receipt',
  'payment',
  'tax',
  'vat',
  'refund',
  'faktura',
  'kvittering',
  'betaling',
  'skatt',
  'mva',
  'regning',
  'kid',
  'refusjon',
  'contract',
  'agreement',
  'terms',
  'kontrakt',
  'avtale',
  'vilkår',
  'password',
  'security',
  'verify',
  'verification',
  'otp',
  'account',
  'passord',
  'sikkerhet',
  'verifiser',
  'innlogging',
  'konto',
  'engangskode',
  'health',
  'medical',
  'prescription',
  'patient',
  'passport',
  'helse',
  'lege',
  'resept',
  'pasient',
  'personnummer',
  'fødselsnummer',
];

/** Per-slice metadata for the config card: display label + (where relevant) its threshold. */
const SLICE_META: Record<
  ActionSlice,
  {
    label: string;
    threshold?: {
      prefKey: 'cleanupLargeMinMb' | 'cleanupColdYears';
      unit: string;
      cmp: string;
      min: number;
      max: number;
    };
  }
> = {
  large: {
    label: 'Large messages',
    threshold: { prefKey: 'cleanupLargeMinMb', unit: 'MB', cmp: '≥', min: 1, max: 500 },
  },
  newsletters: { label: 'Newsletters & bulk mail' },
  'cold-storage': {
    label: 'Cold storage',
    threshold: { prefKey: 'cleanupColdYears', unit: 'years', cmp: '>', min: 1, max: 30 },
  },
};

/**
 * The cleanup config card — replaces the old fixed presets. Each slice has an independent
 * on/off toggle and (where it has one) an inline threshold. Settings persist in synced prefs;
 * the dashboard re-fetches when a threshold changes (the values flow through as query params).
 */
function SliceConfigCard({ prefs }: { prefs: Prefs }) {
  const slices = enabledSlices(prefs);
  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <h2 className="text-base font-semibold text-fg">Cleanup suggestions</h2>
      <p className="mt-1 text-sm text-muted">
        Choose which angles to surface and tune their thresholds. You always confirm before anything
        moves.
      </p>
      <div className="mt-3 divide-y divide-border">
        {SLICE_ORDER.map((id) => {
          const meta = SLICE_META[id];
          const on = slices[id];
          const t = meta.threshold;
          return (
            <div key={id} className="flex items-center gap-3 py-2.5">
              <label className="flex min-w-0 flex-1 items-center gap-3">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) => setPref('cleanupSlices', { ...slices, [id]: e.target.checked })}
                  className="size-4 shrink-0 accent-accent"
                />
                <span className="min-w-0 flex-1 truncate text-sm text-fg">{meta.label}</span>
              </label>
              {t && (
                <div
                  className={`flex shrink-0 items-center gap-1.5 text-sm ${on ? 'text-muted' : 'text-faint'}`}
                >
                  <span>{t.cmp}</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={t.min}
                    max={t.max}
                    value={prefs[t.prefKey]}
                    disabled={!on}
                    onChange={(e) => {
                      const n = Math.round(Number(e.target.value));
                      if (Number.isFinite(n) && n >= t.min && n <= t.max) setPref(t.prefKey, n);
                    }}
                    className="w-16 rounded-lg border border-border bg-surface px-2 py-1 text-right tabular-nums text-fg outline-none focus:border-accent disabled:opacity-50"
                  />
                  <span className="w-12">{t.unit}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-3 rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
        Financial, security, legal and medical mail is always protected, and nothing moves without
        your confirmation.
      </p>
    </section>
  );
}

/**
 * Fully-editable keyword list (cold-storage "keep" words / newsletter markers / the protected
 * gate). Seeded from the built-in `defaults`; every word is a removable chip and any can be
 * added, so the saved list *replaces* the built-ins server-side (remove one and it stops
 * applying). An empty list reverts to the defaults, which is what "Reset" writes. Custom words
 * (not in the defaults) are tinted so it's clear what you've changed. The parent's `onChange`
 * persists + pushes the new list.
 */
function KeywordEditor({
  title,
  hint,
  defaults,
  value,
  onChange,
}: {
  title: string;
  hint?: string;
  defaults: string[];
  value: string[];
  onChange: (list: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  // An empty/unset stored list means "use the built-ins", so the editor shows them as the
  // starting point — editing from there materialises the full list the backend will use.
  const effective = value.length ? value : defaults;
  const customized = value.length > 0;
  const add = () => {
    const term = draft.trim().toLowerCase();
    setDraft('');
    if (!term || effective.includes(term)) return;
    onChange([...effective, term]);
  };
  const remove = (term: string) => onChange(effective.filter((x) => x !== term));
  return (
    <div className="mt-3 border-t border-border pt-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-wide text-faint">{title}</p>
        {customized && (
          <button
            type="button"
            onClick={() => onChange([])}
            className="shrink-0 text-xs font-medium text-accent active:opacity-70"
          >
            Reset to defaults
          </button>
        )}
      </div>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {effective.map((term) => (
          <span
            key={term}
            className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-xs ${
              defaults.includes(term) ? 'bg-surface-2 text-faint' : 'bg-accent/15 text-accent'
            }`}
          >
            {term}
            <button
              type="button"
              onClick={() => remove(term)}
              aria-label={`Remove ${term}`}
              className="active:opacity-70"
            >
              <CloseIcon className="size-3" />
            </button>
          </span>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder="Add a word…"
          className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-fg outline-none focus:border-accent"
        />
        <button
          type="button"
          onClick={add}
          className="flex shrink-0 items-center gap-1 rounded-full px-3 py-1.5 text-sm font-medium text-accent active:bg-surface-2"
        >
          <PlusIcon className="size-4" /> Add
        </button>
      </div>
    </div>
  );
}

/**
 * The "Guarded mail" section — the messages the user has manually shielded (cleanup_keep). A
 * collapsible, paged list with a one-tap release per row, so a message guarded by mistake can
 * be let back into the slices. `onChanged` refreshes the dashboard summary after a release.
 */
function GuardedMailSection({ count, onChanged }: { count: number; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<CleanupMessageDto[] | null>(null);
  const [total, setTotal] = useState(count);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback((offset: number) => {
    if (offset === 0) setMessages(null);
    else setLoadingMore(true);
    setError(false);
    api.cleanup
      .kept({ offset: offset || undefined })
      .then((res) => {
        setMessages((prev) => (offset === 0 || !prev ? res.messages : [...prev, ...res.messages]));
        setTotal(res.total);
        setHasMore(res.truncated);
      })
      .catch(() => setError(true))
      .finally(() => setLoadingMore(false));
  }, []);

  useEffect(() => {
    if (open && messages === null) load(0);
  }, [open, messages, load]);

  const release = (id: string) => {
    setMessages((prev) => prev?.filter((m) => m.id !== id) ?? prev);
    setTotal((t) => Math.max(0, t - 1));
    void api.cleanup
      .keep([id], false)
      .then(onChanged)
      .catch(() => load(0));
  };

  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-baseline justify-between gap-3 text-left"
      >
        <span className="flex items-center gap-2 text-base font-semibold text-fg">
          <ShieldIcon className="size-5 text-accent" /> Guarded mail
        </span>
        <span className="shrink-0 text-sm tabular-nums text-muted">
          {total.toLocaleString()} {open ? '▴' : '▾'}
        </span>
      </button>
      <p className="mt-1 text-sm text-muted">
        Messages you’ve shielded from cleanup. Release any you guarded by mistake.
      </p>
      {open && (
        <div className="mt-3">
          {messages === null ? (
            <div className="flex justify-center py-6">
              <Spinner />
            </div>
          ) : error && messages.length === 0 ? (
            <p className="px-1 py-3 text-center text-sm text-danger">Couldn’t load guarded mail.</p>
          ) : messages.length === 0 ? (
            <p className="px-1 py-3 text-center text-sm text-muted">Nothing guarded.</p>
          ) : (
            <>
              <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                {messages.map((m) => (
                  <li key={m.id}>
                    <CleanupMessageRow m={m} onUnkeep={() => release(m.id)} />
                  </li>
                ))}
              </ul>
              {hasMore && (
                <div className="flex justify-center pt-2">
                  <button
                    type="button"
                    onClick={() => load(messages.length)}
                    disabled={loadingMore}
                    className="flex items-center gap-2 rounded-full border border-border bg-surface px-4 py-1.5 text-sm font-medium text-fg active:bg-surface-2 disabled:opacity-50"
                  >
                    {loadingMore ? <Spinner /> : 'Load more'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

export function Cleanup() {
  const navigate = useNavigate();
  const prefs = usePrefs();
  const { coldYears, largeMinMb } = {
    coldYears: prefs.cleanupColdYears,
    largeMinMb: prefs.cleanupLargeMinMb,
  };
  const slices = enabledSlices(prefs);

  // Stale-while-revalidate: render the last-known dashboard instantly (prefetched on app
  // idle / cached from the previous visit), refresh in the background, swap in the result.
  const [dash, setDash] = useState<CleanupDashboardDto | null>(() =>
    cachedDashboard({ years: coldYears, minMb: largeMinMb }),
  );
  const [error, setError] = useState(false);

  useEffect(() => {
    const params = { years: coldYears, minMb: largeMinMb };
    setDash(cachedDashboard(params));
    setError(false);
    let cancelled = false;
    void loadDashboard(params)
      .then((d) => {
        if (!cancelled) setDash(d);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [coldYears, largeMinMb]);

  // Re-pull the whole dashboard after a cleanup drains (counts/bytes shift).
  const refresh = useCallback(() => {
    void loadDashboard({ years: coldYears, minMb: largeMinMb })
      .then(setDash)
      .catch(() => undefined);
  }, [coldYears, largeMinMb]);

  // A trash run can outlive the screen (or the session) — if work is still queued when the
  // dashboard loads, surface it and keep the figures fresh until the queue drains.
  const [pending, setPending] = useState(0);
  useEffect(() => {
    setPending(dash?.queue.pending ?? 0);
  }, [dash]);
  const draining = pending > 0;
  useEffect(() => {
    if (!draining) return;
    const timer = setInterval(() => {
      void api.cleanup
        .queueStatus()
        .then((status) => {
          setPending(status.pending);
          if (status.pending === 0) refresh();
        })
        .catch(() => {
          /* transient — keep polling */
        });
    }, 2000);
    return () => clearInterval(timer);
  }, [draining, refresh]);

  const summary = dash?.summary ?? null;
  const storage = dash?.storage ?? null;
  const cold = dash?.coldStorage ?? null;
  const large = dash?.large ?? null;
  const newsletters = dash?.newsletters ?? null;

  // Apply a custom-keyword list: persist it, push it to the server now (the keyword sets feed
  // the slice FTS queries), then refresh the dashboard so the new terms take effect immediately.
  const applyKeywords = useCallback(
    (
      key: 'cleanupColdKeepKeywords' | 'cleanupNewsletterKeywords' | 'cleanupProtectedKeywords',
      list: string[],
    ) => {
      setPref(key, list);
      void api
        .putSettings(getPrefs() as unknown as Record<string, unknown>)
        .then(refresh)
        .catch(() => undefined);
    },
    [refresh],
  );

  // An action slice renders as a full card only when its toggle is on.
  const renderAction = (
    sliceId: ActionSlice,
    title: string,
    description: string,
    slice: CleanupSliceDto | null,
    params?: SliceParams,
    footer?: React.ReactNode,
  ) => {
    if (!slices[sliceId]) return null;
    return (
      <ActionSliceCard
        key={sliceId}
        title={title}
        description={description}
        sliceId={sliceId}
        slice={slice}
        params={params}
        onExecuted={refresh}
        footer={footer}
      />
    );
  };

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
        <h1 className="flex-1 truncate px-2 text-lg font-semibold">Cleanup</h1>
      </header>

      <main className="flex-1 overflow-y-auto no-scrollbar">
        {error && !dash ? (
          <p className="px-4 py-8 text-center text-danger">Couldn’t load cleanup analytics.</p>
        ) : (
          <div className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
            {error && (
              <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
                Couldn’t refresh — showing the last known figures.
              </p>
            )}
            {draining && (
              <div className="flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-sm text-fg">
                <Spinner />
                <span>
                  Moving {pending.toLocaleString()} message{pending === 1 ? '' : 's'} to Trash in
                  the background…
                </span>
              </div>
            )}
            {/* Headline storage figures. */}
            <section className="flex items-center gap-4 rounded-xl border border-border bg-surface p-4">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-surface-2 text-accent">
                <SparklesIcon className="size-6" />
              </span>
              {summary === null ? (
                <Spinner />
              ) : (
                <div className="min-w-0 text-sm">
                  <p className="text-fg">
                    <span className="font-semibold">{summary.totalMessages.toLocaleString()}</span>{' '}
                    messages ·{' '}
                    <span className="font-semibold">{formatBytes(summary.totalBytes)}</span> cached
                  </p>
                  <p className="text-muted">
                    {summary.protectedMessages.toLocaleString()} protected from cleanup (financial,
                    security, legal, medical)
                  </p>
                  {summary.trashedMessages > 0 && (
                    <p className="text-muted">
                      Cleanup has freed{' '}
                      <span className="font-medium text-fg">
                        {formatBytes(summary.trashedBytes)}
                      </span>{' '}
                      so far ({summary.trashedMessages.toLocaleString()} messages moved to Trash)
                    </p>
                  )}
                </div>
              )}
            </section>

            {/* Per-slice config — pick which angles to surface and tune their thresholds. */}
            <SliceConfigCard prefs={prefs} />

            {/* Protected mail — the HARD safety gate, extendable with your own words. */}
            <section className="rounded-xl border border-border bg-surface p-4">
              <h2 className="text-base font-semibold text-fg">Protected mail</h2>
              <p className="mt-1 text-sm text-muted">
                Mail whose body contains one of these words is never offered for cleanup. Add your
                own, or remove any you don’t want — removing a word lets that mail be cleaned.
              </p>
              <KeywordEditor
                title="Protected words"
                hint="The full safety gate — edit freely. Reset restores the built-in list."
                defaults={PROTECTED_BUILTINS}
                value={prefs.cleanupProtectedKeywords}
                onChange={(list) => applyKeywords('cleanupProtectedKeywords', list)}
              />
            </section>

            {/* Guarded mail — manually shielded messages, with a one-tap release. */}
            {(summary?.keptMessages ?? 0) > 0 && (
              <GuardedMailSection count={summary!.keptMessages} onChanged={refresh} />
            )}

            <InfoSliceCard
              title="Storage by sender"
              description="Which senders take up the most space — personal-mail providers (gmail, hotmail, …) are split per address. Tick senders to trash the lot; there's no safety gate here, but Keep-flagged mail is spared and everything stays recoverable in Trash."
              slice={storage}
              onExecuted={refresh}
            />
            {renderAction(
              'large',
              'Large messages',
              `Messages over ${largeMinMb} MB still on your mail provider — usually big attachments. Mail already detached to this server doesn't count (trashing it wouldn't free provider space).`,
              large,
              { minMb: largeMinMb },
            )}
            {renderAction(
              'newsletters',
              'Newsletters & bulk mail',
              'Mail carrying an unsubscribe link — newsletters, promotions and other bulk sends.',
              newsletters,
              undefined,
              <KeywordEditor
                title="Words that flag bulk mail"
                hint="Mail whose body contains one of these is treated as a newsletter."
                defaults={['unsubscribe', 'newsletter', 'avmeld', 'nyhetsbrev', 'meld deg av']}
                value={prefs.cleanupNewsletterKeywords}
                onChange={(list) => applyKeywords('cleanupNewsletterKeywords', list)}
              />,
            )}
            {renderAction(
              'cold-storage',
              'Cold storage',
              `Mail older than ${coldYears} year${coldYears === 1 ? '' : 's'} with no invoice, tax or contract — safe to let go.`,
              cold,
              { years: coldYears },
              <KeywordEditor
                title="Words that keep mail"
                hint="An old message whose body contains one of these is spared from this slice."
                defaults={[
                  'invoice',
                  'faktura',
                  'tax',
                  'skatt',
                  'mva',
                  'contract',
                  'kontrakt',
                  'avtale',
                ]}
                value={prefs.cleanupColdKeepKeywords}
                onChange={(list) => applyKeywords('cleanupColdKeepKeywords', list)}
              />,
            )}

            <p className="px-1 pb-4 text-center text-xs text-faint">
              Reach for this when you want to — nothing here is a task. Cleanup moves mail to Trash
              (recoverable), never a permanent delete.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
