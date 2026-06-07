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
import { useNavigate } from 'react-router-dom';
import type { CleanupSliceDto, CleanupSummaryDto } from '@maily/shared';
import { api } from '../api/client';
import { Spinner } from '../ui/Spinner';
import { BackIcon, SparklesIcon } from '../ui/icons';

/** Delete-eligible slice ids (must match the backend's DELETE_ELIGIBLE set). */
type ActionSlice = 'never-replied' | 'cold-storage';

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

/**
 * Per-domain breakdown — the "quick-review the list" affordance. When `selectable`, each
 * row gets a checkbox so the user can uncheck domains to spare (the unchecked set is sent
 * to the server as `excludeDomains`).
 */
function GroupList({
  slice,
  selectable = false,
  excluded,
  onToggle,
}: {
  slice: CleanupSliceDto;
  selectable?: boolean;
  excluded?: Set<string>;
  onToggle?: (domain: string) => void;
}) {
  if (slice.groups.length === 0) {
    return <p className="px-1 py-2 text-sm text-muted">Nothing here — nice and tidy.</p>;
  }

  const rows = slice.groups.map((g) => {
    const sparing = selectable && excluded?.has(g.domain);
    return (
      <li
        key={g.domain}
        className={`flex items-center justify-between gap-3 px-3 py-2 text-sm ${
          sparing ? 'opacity-40' : ''
        }`}
      >
        {selectable && (
          <input
            type="checkbox"
            checked={!sparing}
            onChange={() => onToggle?.(g.domain)}
            aria-label={`Include ${g.domain}`}
            className="size-4 shrink-0 accent-accent"
          />
        )}
        <span className="min-w-0 flex-1 truncate text-fg">{g.domain}</span>
        <span className="shrink-0 tabular-nums text-muted">{g.messageCount} msg</span>
        <span className="w-20 shrink-0 text-right tabular-nums text-faint">
          {formatBytes(g.bytes)}
        </span>
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
        <span className="group-open:hidden">Quick-review by sender ▾</span>
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
}: {
  title: string;
  description: string;
  sliceId: ActionSlice;
  slice: CleanupSliceDto | null;
  years?: number;
  onExecuted: () => void;
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
              className="shrink-0 rounded-full bg-accent px-3 py-1 text-xs font-medium text-white active:opacity-80"
            >
              Clean up…
            </button>
          </div>
          <GroupList slice={slice} />
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
          <GroupList slice={slice} selectable excluded={excluded} onToggle={toggle} />
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

export function Cleanup() {
  const navigate = useNavigate();
  const [summary, setSummary] = useState<CleanupSummaryDto | null>(null);
  const [storage, setStorage] = useState<CleanupSliceDto | null>(null);
  const [neverReplied, setNeverReplied] = useState<CleanupSliceDto | null>(null);
  const [cold, setCold] = useState<CleanupSliceDto | null>(null);
  const [error, setError] = useState(false);

  async function load() {
    try {
      const [s, st, nr, c] = await Promise.all([
        api.cleanup.summary(),
        api.cleanup.storage(),
        api.cleanup.neverReplied(),
        api.cleanup.coldStorage(),
      ]);
      setSummary(s);
      setStorage(st);
      setNeverReplied(nr);
      setCold(c);
    } catch {
      setError(true);
    }
  }

  useEffect(() => {
    void load();
  }, []);

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
      .coldStorage()
      .then(setCold)
      .catch(() => undefined);
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

            <InfoSliceCard
              title="Storage by sender"
              description="Which domains take up the most space. Informational — a storage audit, not a delete list."
              slice={storage}
            />
            <ActionSliceCard
              title="Never replied to"
              description="Senders you’ve never written back to — likely newsletters and clutter."
              sliceId="never-replied"
              slice={neverReplied}
              onExecuted={refresh}
            />
            <ActionSliceCard
              title="Cold storage"
              description="Mail older than 2 years with no invoice, tax or contract — safe to let go."
              sliceId="cold-storage"
              slice={cold}
              onExecuted={refresh}
            />

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
