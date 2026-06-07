/**
 * Cleanup Dashboard (ROADMAP Phase 6 "Master archive & Cleanup Dashboard"). An opt-in
 * power tool over the local SQLite archive — *not* a backlog to clear. It previews the
 * impact (message count + estimated storage, grouped by sender domain) of deterministic
 * cleanup slices so a future 1-click preset can say "delete N, free X" before acting.
 *
 * Read-only for now: the destructive execution path (rate-limited IMAP trash queue,
 * archive-before-delete staging, presets) lands in a later pass, so the per-slice action
 * is shown but disabled. Delete-eligible slices are already safety-filtered server-side
 * (financial / legal / account / medical mail is protected — HARD RULE).
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { CleanupSliceDto, CleanupSummaryDto } from '@maily/shared';
import { api } from '../api/client';
import { Spinner } from '../ui/Spinner';
import { BackIcon, SparklesIcon } from '../ui/icons';

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

/** Expandable per-domain breakdown — the "quick-review the list" affordance. */
function GroupList({ slice }: { slice: CleanupSliceDto }) {
  if (slice.groups.length === 0) {
    return <p className="px-1 py-2 text-sm text-muted">Nothing here — nice and tidy.</p>;
  }
  return (
    <details className="group mt-2">
      <summary className="cursor-pointer select-none list-none text-sm font-medium text-accent">
        <span className="group-open:hidden">Quick-review by sender ▾</span>
        <span className="hidden group-open:inline">Hide ▴</span>
      </summary>
      <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
        {slice.groups.map((g) => (
          <li key={g.domain} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
            <span className="min-w-0 flex-1 truncate text-fg">{g.domain}</span>
            <span className="shrink-0 tabular-nums text-muted">{g.messageCount} msg</span>
            <span className="w-20 shrink-0 text-right tabular-nums text-faint">
              {formatBytes(g.bytes)}
            </span>
          </li>
        ))}
        {slice.truncated && (
          <li className="px-3 py-2 text-center text-xs text-faint">
            …and more (top {slice.groups.length} shown)
          </li>
        )}
      </ul>
    </details>
  );
}

/** A single slice card. `actionable` slices show a (disabled) cleanup preset header. */
function SliceCard({
  title,
  description,
  slice,
  actionable,
}: {
  title: string;
  description: string;
  slice: CleanupSliceDto | null;
  actionable: boolean;
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
        <>
          {actionable && slice.totalMessages > 0 && (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-surface-2 px-3 py-2">
              <span className="text-sm text-fg">
                Delete {slice.totalMessages.toLocaleString()} · free{' '}
                <span className="font-medium">{formatBytes(slice.totalBytes)}</span>
              </span>
              <button
                type="button"
                disabled
                title="Execution lands in a later update"
                className="shrink-0 cursor-not-allowed rounded-full bg-border px-3 py-1 text-xs font-medium text-faint"
              >
                Coming soon
              </button>
            </div>
          )}
          <GroupList slice={slice} />
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

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [s, st, nr, c] = await Promise.all([
          api.cleanup.summary(),
          api.cleanup.storage(),
          api.cleanup.neverReplied(),
          api.cleanup.coldStorage(),
        ]);
        if (!active) return;
        setSummary(s);
        setStorage(st);
        setNeverReplied(nr);
        setCold(c);
      } catch {
        if (active) setError(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

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

            <SliceCard
              title="Storage by sender"
              description="Which domains take up the most space. Informational — a storage audit, not a delete list."
              slice={storage}
              actionable={false}
            />
            <SliceCard
              title="Never replied to"
              description="Senders you’ve never written back to — likely newsletters and clutter."
              slice={neverReplied}
              actionable
            />
            <SliceCard
              title="Cold storage"
              description="Mail older than 2 years with no invoice, tax or contract — safe to let go."
              slice={cold}
              actionable
            />

            <p className="px-1 pb-4 text-center text-xs text-faint">
              Reach for this when you want to — nothing here is a task. One-click cleanup, with a
              preview of exactly what goes, is coming next.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
