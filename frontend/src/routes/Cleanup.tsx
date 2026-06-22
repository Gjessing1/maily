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
import { api } from '../api/client';
import { setPref, usePrefs } from '../state/prefs';
import { cachedDashboard, loadDashboard } from '../state/cleanupDash';
import { PRESETS, PRESET_ORDER, type ActionSlice, type SliceParams } from '../state/cleanupPresets';
import { Spinner } from '../ui/Spinner';
import {
  BackIcon,
  ChevronDownIcon,
  MailOpenIcon,
  SearchIcon,
  ShieldIcon,
  SparklesIcon,
} from '../ui/icons';

export type { SliceParams } from '../state/cleanupPresets';

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
  'never-replied': 'Never replied to',
  'cold-storage': 'Cold storage',
  large: 'Large messages',
  unread: 'Never opened',
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
}: {
  m: CleanupMessageDto;
  selectable?: boolean;
  selected?: boolean;
  onToggle?: () => void;
  onKeep?: () => void;
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

  return (
    <Link to={`/m/${m.id}`} className="flex items-center gap-3 px-3 py-2 active:bg-surface-2">
      {body}
    </Link>
  );
}

/** What a {@link SenderBrowser} lists, and (for action slices) where a sender row drills to. */
type BrowseSource = { slice: 'storage' | ActionSlice; params?: SliceParams };

/** Build the drill-down URL query for a slice (+ optional sender), carrying its thresholds. */
export function drillQuery(slice: ActionSlice, params: SliceParams = {}, domain?: string): string {
  const p = new URLSearchParams({ slice });
  if (domain) p.set('domain', domain);
  if (params.years) p.set('years', String(params.years));
  if (params.minMb) p.set('minMb', String(params.minMb));
  if (params.months) p.set('months', String(params.months));
  return p.toString();
}

/**
 * Collapsible "Review by sender" — a searchable, paginated per-domain list. Owns its own
 * fetching so it can page the long tail (Load more) and filter by a domain substring (the
 * search box) without re-rendering the whole dashboard. For action slices each row navigates
 * to the message drill-down (where messages are selected + trashed); the informational storage
 * slice has no drill, so its rows are static.
 */
function SenderBrowser({ source }: { source: BrowseSource }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [groups, setGroups] = useState<CleanupGroupDto[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);

  const kind = source.slice;
  const { years, minMb, months } = source.params ?? {};

  const fetchPage = useCallback(
    (opts: { q?: string; offset?: number }): Promise<CleanupSliceDto> => {
      switch (kind) {
        case 'storage':
          return api.cleanup.storage(opts);
        case 'never-replied':
          return api.cleanup.neverReplied(opts);
        case 'cold-storage':
          return api.cleanup.coldStorage(years, opts);
        case 'large':
          return api.cleanup.large(minMb, opts);
        case 'unread':
          return api.cleanup.unread(months, opts);
        case 'newsletters':
          return api.cleanup.newsletters(opts);
      }
    },
    [kind, years, minMb, months],
  );

  // (Re)load the first page when opened or the (debounced) search term changes.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    const t = setTimeout(
      () => {
        fetchPage({ q: q || undefined })
          .then((res) => {
            if (cancelled) return;
            setGroups(res.groups);
            setHasMore(res.truncated);
          })
          .catch(() => {
            if (!cancelled) setError(true);
          })
          .finally(() => {
            if (!cancelled) setLoading(false);
          });
      },
      q ? 250 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, q, fetchPage]);

  const loadMore = () => {
    setLoadingMore(true);
    setError(false);
    fetchPage({ q: q || undefined, offset: groups.length })
      .then((res) => {
        setGroups((prev) => [...prev, ...res.groups]);
        setHasMore(res.truncated);
      })
      .catch(() => setError(true))
      .finally(() => setLoadingMore(false));
  };

  const drillInto = (domain: string) => {
    if (kind === 'storage') return;
    navigate(`/cleanup/messages?${drillQuery(kind, source.params, domain)}`);
  };

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

          {loading ? (
            <div className="flex justify-center py-6">
              <Spinner />
            </div>
          ) : error && groups.length === 0 ? (
            <p className="px-1 py-3 text-center text-sm text-danger">Couldn’t load senders.</p>
          ) : groups.length === 0 ? (
            <p className="px-1 py-3 text-center text-sm text-muted">
              {q ? 'No senders match.' : 'Nothing here — nice and tidy.'}
            </p>
          ) : (
            <>
              <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
                {groups.map((g) => (
                  <li key={g.domain}>
                    {kind === 'storage' ? (
                      <div className="flex items-center gap-3 px-3 py-2 text-sm">
                        <span className="min-w-0 flex-1 truncate text-fg">{g.domain}</span>
                        <span className="shrink-0 tabular-nums text-muted">
                          {g.messageCount} msg
                        </span>
                        <span className="w-20 shrink-0 text-right tabular-nums text-faint">
                          {formatBytes(g.bytes)}
                        </span>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => drillInto(g.domain)}
                        aria-label={`Review messages from ${g.domain}`}
                        className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm active:bg-surface-2"
                      >
                        <span className="min-w-0 flex-1 truncate text-fg">{g.domain}</span>
                        <span className="shrink-0 tabular-nums text-muted">
                          {g.messageCount} msg
                        </span>
                        <span className="w-20 shrink-0 text-right tabular-nums text-faint">
                          {formatBytes(g.bytes)}
                        </span>
                        <ChevronDownIcon className="size-4 shrink-0 -rotate-90 text-faint" />
                      </button>
                    )}
                  </li>
                ))}
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
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** A read-only (informational) slice card — the storage audit. */
function InfoSliceCard({
  title,
  description,
  slice,
}: {
  title: string;
  description: string;
  slice: CleanupSliceDto | null;
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
        <SenderBrowser source={{ slice: 'storage' }} />
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
}: {
  title: string;
  description: string;
  sliceId: ActionSlice;
  slice: CleanupSliceDto | null;
  params?: SliceParams;
  onExecuted: () => void;
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
    </section>
  );
}

export function Cleanup() {
  const navigate = useNavigate();
  const prefs = usePrefs();
  const preset = PRESETS[prefs.cleanupPreset] ? prefs.cleanupPreset : 'balanced';
  const { coldYears, largeMinMb, unreadMonths } = PRESETS[preset];

  // Stale-while-revalidate: render the last-known dashboard instantly (prefetched on app
  // idle / cached from the previous visit), refresh in the background, swap in the result.
  const [dash, setDash] = useState<CleanupDashboardDto | null>(() =>
    cachedDashboard({ years: coldYears, minMb: largeMinMb, months: unreadMonths }),
  );
  const [error, setError] = useState(false);

  useEffect(() => {
    const params = { years: coldYears, minMb: largeMinMb, months: unreadMonths };
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
  }, [coldYears, largeMinMb, unreadMonths]);

  // Re-pull the whole dashboard after a cleanup drains (counts/bytes shift).
  const refresh = useCallback(() => {
    void loadDashboard({ years: coldYears, minMb: largeMinMb, months: unreadMonths })
      .then(setDash)
      .catch(() => undefined);
  }, [coldYears, largeMinMb, unreadMonths]);

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
  const neverReplied = dash?.neverReplied ?? null;
  const cold = dash?.coldStorage ?? null;
  const large = dash?.large ?? null;
  const unread = dash?.unread ?? null;
  const newsletters = dash?.newsletters ?? null;

  // An action slice renders as a full card only when the active preset surfaces it.
  const renderAction = (
    sliceId: ActionSlice,
    title: string,
    description: string,
    slice: CleanupSliceDto | null,
    params?: SliceParams,
  ) => {
    if (!PRESETS[preset].slices.includes(sliceId)) return null;
    return (
      <ActionSliceCard
        key={sliceId}
        title={title}
        description={description}
        sliceId={sliceId}
        slice={slice}
        params={params}
        onExecuted={refresh}
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

            {/* 1-click aggressiveness preset — a profile over the action slices below. */}
            <section className="rounded-xl border border-border bg-surface p-4">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-base font-semibold text-fg">Cleanup style</h2>
              </div>
              <p className="mt-1 text-sm text-muted">
                How aggressively to suggest cleanup. You always confirm before anything moves.
              </p>
              <div
                role="radiogroup"
                aria-label="Cleanup style"
                className="mt-3 flex gap-1 rounded-full bg-surface-2 p-1"
              >
                {PRESET_ORDER.map((p) => (
                  <button
                    key={p}
                    type="button"
                    role="radio"
                    aria-checked={preset === p}
                    onClick={() => setPref('cleanupPreset', p)}
                    className={`flex-1 rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                      preset === p ? 'bg-accent text-white' : 'text-muted active:bg-surface'
                    }`}
                  >
                    {PRESETS[p].label}
                  </button>
                ))}
              </div>
              {/* Spell out what the active style actually surfaces, so the choice isn't opaque. */}
              <div className="mt-3 rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
                <p>
                  <span className="font-medium text-fg">{PRESETS[preset].label}</span> changes which
                  suggestion cards appear below and their thresholds:
                </p>
                <ul className="mt-1 list-inside list-disc space-y-0.5">
                  <li>
                    mail older than {coldYears} year{coldYears === 1 ? '' : 's'} with no invoice,
                    tax or contract
                  </li>
                  <li>messages over {largeMinMb} MB</li>
                  {PRESETS[preset].slices.includes('unread') && (
                    <li>mail still unopened after {unreadMonths} months</li>
                  )}
                  {PRESETS[preset].slices.includes('never-replied') && (
                    <li>senders you’ve never replied to</li>
                  )}
                  {PRESETS[preset].slices.includes('newsletters') && (
                    <li>newsletters &amp; bulk mail (unsubscribe link)</li>
                  )}
                </ul>
                <p className="mt-1">
                  Financial, security, legal and medical mail is always protected, and nothing moves
                  without your confirmation.
                </p>
              </div>
            </section>

            <InfoSliceCard
              title="Storage by sender"
              description="Which senders take up the most space — personal-mail providers (gmail, hotmail, …) are split per address. Informational — a storage audit, not a delete list."
              slice={storage}
            />
            {renderAction(
              'large',
              'Large messages',
              `Messages over ${largeMinMb} MB — usually big attachments. The quickest way to free space.`,
              large,
              { minMb: largeMinMb },
            )}
            {renderAction(
              'never-replied',
              'Never replied to',
              'Senders you’ve never written back to — likely newsletters and clutter.',
              neverReplied,
            )}
            {renderAction(
              'newsletters',
              'Newsletters & bulk mail',
              'Mail carrying an unsubscribe link — newsletters, promotions and other bulk sends.',
              newsletters,
            )}
            {renderAction(
              'unread',
              'Never opened',
              `Unread mail older than ${unreadMonths} months — you never opened it. Flagged mail is spared.`,
              unread,
              { months: unreadMonths },
            )}
            {renderAction(
              'cold-storage',
              'Cold storage',
              `Mail older than ${coldYears} year${coldYears === 1 ? '' : 's'} with no invoice, tax or contract — safe to let go.`,
              cold,
              { years: coldYears },
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
