/**
 * Cleanup Dashboard (ROADMAP Phase 6 "Master archive & Cleanup Dashboard"). An opt-in
 * power tool over the local SQLite archive — *not* a backlog to clear. It previews the
 * impact (message count + estimated storage, grouped by sender domain) of deterministic
 * cleanup slices, then (Phase 6b) executes them via a review-less 1-click flow: a decided
 * action with an "uncheck by domain" escape hatch and an explicit confirm.
 *
 * Execution is Trash-only and recoverable: the server re-validates the HARD safety gate
 * (financial / legal / account / medical mail is protected), tombstones the messages, and a
 * rate-limited background queue MOVEs them to Trash — never EXPUNGE. The dashboard shows the
 * "Moving N to Trash…" progress until the queue drains.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { CleanupMessageDto, CleanupSliceDto, CleanupSummaryDto } from '@maily/shared';
import { api } from '../api/client';
import { setPref, usePrefs, type CleanupPreset } from '../state/prefs';
import { Spinner } from '../ui/Spinner';
import { BackIcon, ChevronDownIcon, SparklesIcon } from '../ui/icons';

/** Delete-eligible slice ids (must match the backend's DELETE_ELIGIBLE set). */
type ActionSlice = 'never-replied' | 'cold-storage';

/**
 * The 1-click aggressiveness presets (ROADMAP Phase 6b.2). A preset is a profile over
 * the deterministic slices: `coldYears` is the cold-storage age threshold (smaller =
 * more aggressive), and `slices` is which action slices it surfaces at all — 'strict'
 * withholds the never-replied heuristic (a sender being silent is a softer signal than
 * age, so the cautious profile leaves it out). The backend already honours `years` on
 * both the preview and execute paths, so the preset is purely a client-side profile.
 */
const PRESETS: Record<CleanupPreset, { label: string; coldYears: number; slices: ActionSlice[] }> =
  {
    strict: { label: 'Strict', coldYears: 5, slices: ['cold-storage'] },
    balanced: { label: 'Balanced', coldYears: 2, slices: ['never-replied', 'cold-storage'] },
    aggressive: { label: 'Aggressive', coldYears: 1, slices: ['never-replied', 'cold-storage'] },
  };
const PRESET_ORDER: CleanupPreset[] = ['strict', 'balanced', 'aggressive'];

/** Human-readable byte size (1 KB = 1024 B). */
function formatBytes(n: number): string {
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
 * One drill-down message row — subject + sender/date + size, linking to the reader so the
 * user can inspect a message before it's trashed (deep link uses the internal UUID). Shared
 * by the inline expansion here and the dedicated drill-down screen.
 */
export function CleanupMessageRow({ m }: { m: CleanupMessageDto }) {
  return (
    <Link to={`/m/${m.id}`} className="flex items-center gap-3 px-3 py-2 active:bg-surface-2">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-fg">{m.subject || '(no subject)'}</span>
        <span className="block truncate text-xs text-faint">
          {(m.fromName || m.fromAddress || 'Unknown sender') + ' · ' + formatMsgDate(m.receivedAt)}
        </span>
      </span>
      <span className="shrink-0 text-xs tabular-nums text-faint">{formatBytes(m.bytes)}</span>
    </Link>
  );
}

/** Senders with at most this many messages expand inline; bigger ones open a full screen. */
const INLINE_MAX = 10;

/**
 * Per-domain breakdown with message-level drill-down. Each sender row reveals its actual
 * messages: small senders (≤ {@link INLINE_MAX}) expand inline (lazy-fetched); larger ones
 * open the dedicated drill-down screen (kept off-list so the card stays scannable). When
 * `selectable`, each row also gets a checkbox to spare a domain (sent as `excludeDomains`).
 * `drill` is omitted for the informational storage card (no message drill-down there).
 */
function GroupList({
  slice,
  selectable = false,
  excluded,
  onToggle,
  drill,
}: {
  slice: CleanupSliceDto;
  selectable?: boolean;
  excluded?: Set<string>;
  onToggle?: (domain: string) => void;
  drill?: { sliceId: ActionSlice; years?: number };
}) {
  const navigate = useNavigate();
  const [openDomain, setOpenDomain] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Record<string, CleanupMessageDto[] | 'loading' | 'error'>>({});

  if (slice.groups.length === 0) {
    return <p className="px-1 py-2 text-sm text-muted">Nothing here — nice and tidy.</p>;
  }

  const drillInto = (domain: string, count: number) => {
    if (!drill) return;
    // Big senders get their own screen; small ones expand right here (the user's call).
    if (count > INLINE_MAX) {
      const q = new URLSearchParams({ slice: drill.sliceId, domain });
      if (drill.years) q.set('years', String(drill.years));
      navigate(`/cleanup/messages?${q.toString()}`);
      return;
    }
    const next = openDomain === domain ? null : domain;
    setOpenDomain(next);
    if (next && !msgs[domain]) {
      setMsgs((m) => ({ ...m, [domain]: 'loading' }));
      api.cleanup
        .messages({ slice: drill.sliceId, domain, years: drill.years, limit: INLINE_MAX + 5 })
        .then((res) => setMsgs((m) => ({ ...m, [domain]: res.messages })))
        .catch(() => setMsgs((m) => ({ ...m, [domain]: 'error' })));
    }
  };

  const rows = slice.groups.map((g) => {
    const sparing = selectable && excluded?.has(g.domain);
    const open = openDomain === g.domain;
    const cached = msgs[g.domain];
    const navigates = g.messageCount > INLINE_MAX;
    return (
      <li key={g.domain} className={sparing ? 'opacity-40' : ''}>
        <div className="flex items-center gap-3 px-3 py-2 text-sm">
          {selectable && (
            <input
              type="checkbox"
              checked={!sparing}
              onChange={() => onToggle?.(g.domain)}
              aria-label={`Include ${g.domain}`}
              className="size-4 shrink-0 accent-accent"
            />
          )}
          {drill ? (
            <button
              type="button"
              onClick={() => drillInto(g.domain, g.messageCount)}
              aria-expanded={navigates ? undefined : open}
              aria-label={`${navigates ? 'View' : open ? 'Hide' : 'Show'} messages from ${g.domain}`}
              className="flex min-w-0 flex-1 items-center gap-2 text-left active:opacity-70"
            >
              <span className="min-w-0 flex-1 truncate text-fg">{g.domain}</span>
              <ChevronDownIcon
                className={`size-4 shrink-0 text-faint transition-transform ${
                  navigates ? '-rotate-90' : open ? 'rotate-180' : ''
                }`}
              />
            </button>
          ) : (
            <span className="min-w-0 flex-1 truncate text-fg">{g.domain}</span>
          )}
          <span className="shrink-0 tabular-nums text-muted">{g.messageCount} msg</span>
          <span className="w-20 shrink-0 text-right tabular-nums text-faint">
            {formatBytes(g.bytes)}
          </span>
        </div>
        {open && (
          <div className="border-t border-border bg-surface-2/40">
            {cached === undefined || cached === 'loading' ? (
              <div className="flex justify-center py-3">
                <Spinner />
              </div>
            ) : cached === 'error' ? (
              <p className="px-3 py-2 text-xs text-danger">Couldn’t load messages.</p>
            ) : cached.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted">No messages.</p>
            ) : (
              <ul className="divide-y divide-border">
                {cached.map((m) => (
                  <li key={m.id}>
                    <CleanupMessageRow m={m} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </li>
    );
  });

  const list = (
    <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
      {rows}
      {slice.truncated && (
        <li className="px-3 py-2 text-center text-xs text-faint">
          …and more (top {slice.groups.length} shown
          {selectable ? '; the rest are included' : ''})
        </li>
      )}
    </ul>
  );

  // In confirm mode the list is always expanded (it IS the review surface).
  if (selectable) return list;

  return (
    <details className="group mt-2">
      <summary className="cursor-pointer select-none list-none text-sm font-medium text-accent">
        <span className="group-open:hidden">Browse by sender ▾</span>
        <span className="hidden group-open:inline">Hide ▴</span>
      </summary>
      {list}
    </details>
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
        <GroupList slice={slice} />
      )}
    </section>
  );
}

/**
 * A delete-eligible slice card with the review-less execution flow: a decided action →
 * confirm (with per-domain unchecking) → background trashing with progress. `onExecuted`
 * lets the parent refresh totals once the queue drains.
 */
function ActionSliceCard({
  title,
  description,
  sliceId,
  slice,
  years,
  onExecuted,
  onSuppress,
}: {
  title: string;
  description: string;
  sliceId: ActionSlice;
  slice: CleanupSliceDto | null;
  years?: number;
  onExecuted: () => void;
  onSuppress: () => void;
}) {
  const [mode, setMode] = useState<'idle' | 'confirm' | 'running' | 'done' | 'error'>('idle');
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [queued, setQueued] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(
    () => () => {
      if (pollRef.current) clearInterval(pollRef.current);
    },
    [],
  );

  const toggle = (domain: string) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(domain)) next.delete(domain);
      else next.add(domain);
      return next;
    });
  };

  // Spared (visible) domains can be subtracted exactly; unchecking only touches visible rows.
  const sparedShown = slice ? slice.groups.filter((g) => excluded.has(g.domain)) : [];
  const msgToDelete =
    (slice?.totalMessages ?? 0) - sparedShown.reduce((n, g) => n + g.messageCount, 0);
  const bytesToFree = (slice?.totalBytes ?? 0) - sparedShown.reduce((n, g) => n + g.bytes, 0);

  async function execute() {
    if (!slice) return;
    setMode('running');
    try {
      const res = await api.cleanup.execute({
        slice: sliceId,
        years,
        excludeDomains: [...excluded],
      });
      setQueued(res.queued);
      // Poll the global trash queue until it drains, then refresh the dashboard totals.
      pollRef.current = setInterval(() => {
        void api.cleanup
          .queueStatus()
          .then((q) => {
            if (q.pending === 0) {
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
        <GroupList slice={slice} />
      ) : mode === 'done' ? (
        <p className="mt-3 rounded-lg bg-surface-2 px-3 py-2 text-sm text-fg">
          Moved {queued.toLocaleString()} to Trash — recoverable there if you need them back.
        </p>
      ) : mode === 'running' ? (
        <div className="mt-3 flex items-center gap-3 rounded-lg bg-surface-2 px-3 py-2 text-sm text-fg">
          <Spinner />
          <span>Moving {(queued || msgToDelete).toLocaleString()} to Trash…</span>
        </div>
      ) : mode === 'idle' ? (
        <>
          <div className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-surface-2 px-3 py-2">
            <span className="text-sm text-fg">
              Delete {slice.totalMessages.toLocaleString()} · free{' '}
              <span className="font-medium">{formatBytes(slice.totalBytes)}</span>
            </span>
            <button
              type="button"
              onClick={() => setMode('confirm')}
              className="shrink-0 rounded-full border border-border px-3 py-1 text-xs font-medium text-fg active:bg-surface-2"
            >
              Review…
            </button>
          </div>
          <GroupList slice={slice} drill={{ sliceId, years }} />
          <button
            type="button"
            onClick={onSuppress}
            className="mt-3 text-xs font-medium text-faint underline-offset-2 hover:underline active:text-muted"
          >
            Don’t suggest this again
          </button>
        </>
      ) : (
        // confirm / error
        <>
          {mode === 'error' && (
            <p className="mt-3 text-sm text-danger">Couldn’t start cleanup — try again.</p>
          )}
          <p className="mt-3 text-sm text-fg">
            Move <span className="font-medium">{msgToDelete.toLocaleString()}</span> to Trash and
            free <span className="font-medium">{formatBytes(Math.max(0, bytesToFree))}</span>?
            Uncheck any sender to spare it.
          </p>
          <GroupList
            slice={slice}
            selectable
            excluded={excluded}
            onToggle={toggle}
            drill={{ sliceId, years }}
          />
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void execute()}
              disabled={msgToDelete <= 0}
              className="rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-white active:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Move to Trash
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('idle');
                setExcluded(new Set());
              }}
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

/** Collapsed stand-in for a slice the user dismissed via "Don't suggest this again". */
function SuppressedRow({ title, onRestore }: { title: string; onRestore: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-dashed border-border px-4 py-3">
      <span className="text-sm text-faint">“{title}” hidden</span>
      <button
        type="button"
        onClick={onRestore}
        className="shrink-0 text-xs font-medium text-accent active:opacity-80"
      >
        Show again
      </button>
    </div>
  );
}

export function Cleanup() {
  const navigate = useNavigate();
  const prefs = usePrefs();
  const preset = PRESETS[prefs.cleanupPreset] ? prefs.cleanupPreset : 'balanced';
  const coldYears = PRESETS[preset].coldYears;
  const suppressed = new Set(prefs.cleanupSuppressed);

  const [summary, setSummary] = useState<CleanupSummaryDto | null>(null);
  const [storage, setStorage] = useState<CleanupSliceDto | null>(null);
  const [neverReplied, setNeverReplied] = useState<CleanupSliceDto | null>(null);
  const [cold, setCold] = useState<CleanupSliceDto | null>(null);
  const [error, setError] = useState(false);

  // Mount-only pulls — summary / storage / never-replied don't depend on the preset.
  useEffect(() => {
    void (async () => {
      try {
        const [s, st, nr] = await Promise.all([
          api.cleanup.summary(),
          api.cleanup.storage(),
          api.cleanup.neverReplied(),
        ]);
        setSummary(s);
        setStorage(st);
        setNeverReplied(nr);
      } catch {
        setError(true);
      }
    })();
  }, []);

  // Cold-storage depends on the preset's age threshold — refetch when it changes.
  useEffect(() => {
    setCold(null);
    void api.cleanup
      .coldStorage(coldYears)
      .then(setCold)
      .catch(() => setError(true));
  }, [coldYears]);

  // Re-pull the affected slice + headline after a cleanup drains (counts/bytes shift).
  const refresh = () => {
    void api.cleanup
      .summary()
      .then(setSummary)
      .catch(() => undefined);
    void api.cleanup
      .neverReplied()
      .then(setNeverReplied)
      .catch(() => undefined);
    void api.cleanup
      .coldStorage(coldYears)
      .then(setCold)
      .catch(() => undefined);
  };

  const setSuppressed = (sliceId: ActionSlice, hidden: boolean) => {
    const next = new Set(prefs.cleanupSuppressed);
    if (hidden) next.add(sliceId);
    else next.delete(sliceId);
    setPref('cleanupSuppressed', [...next]);
  };

  // An action slice renders as a full card only when the preset surfaces it and the user
  // hasn't dismissed it; a dismissed-but-in-preset slice collapses to a "show again" row.
  const renderAction = (
    sliceId: ActionSlice,
    title: string,
    description: string,
    slice: CleanupSliceDto | null,
    years?: number,
  ) => {
    if (!PRESETS[preset].slices.includes(sliceId)) return null;
    if (suppressed.has(sliceId)) {
      return (
        <SuppressedRow
          key={sliceId}
          title={title}
          onRestore={() => setSuppressed(sliceId, false)}
        />
      );
    }
    return (
      <ActionSliceCard
        key={sliceId}
        title={title}
        description={description}
        sliceId={sliceId}
        slice={slice}
        years={years}
        onExecuted={refresh}
        onSuppress={() => setSuppressed(sliceId, true)}
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
        {error ? (
          <p className="px-4 py-8 text-center text-danger">Couldn’t load cleanup analytics.</p>
        ) : (
          <div className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
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
              <p className="mt-3 rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
                <span className="font-medium text-fg">{PRESETS[preset].label}</span> suggests mail
                older than {coldYears} year{coldYears === 1 ? '' : 's'} with no invoice, tax or
                contract
                {PRESETS[preset].slices.includes('never-replied')
                  ? ', plus senders you’ve never replied to'
                  : ''}
                . Financial, security, legal and medical mail is always protected.
              </p>
            </section>

            <InfoSliceCard
              title="Storage by sender"
              description="Which domains take up the most space. Informational — a storage audit, not a delete list."
              slice={storage}
            />
            {renderAction(
              'never-replied',
              'Never replied to',
              'Senders you’ve never written back to — likely newsletters and clutter.',
              neverReplied,
            )}
            {renderAction(
              'cold-storage',
              'Cold storage',
              `Mail older than ${coldYears} year${coldYears === 1 ? '' : 's'} with no invoice, tax or contract — safe to let go.`,
              cold,
              coldYears,
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
