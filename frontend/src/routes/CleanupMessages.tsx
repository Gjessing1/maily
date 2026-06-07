/**
 * Cleanup drill-down screen (ROADMAP Phase 6b review surface). A dedicated, full-screen
 * list of the individual messages a delete-eligible slice would trash — opened for a single
 * sender that has too many messages to expand inline on the Cleanup card. Read-only: it
 * lists what's in scope and links each message to the reader; nothing is deleted here (the
 * confirm/execute step stays on the Cleanup screen). The same safety + slice predicates run
 * server-side, so what's shown is exactly what an execute would move.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { CleanupMessageDto } from '@maily/shared';
import { api } from '../api/client';
import { Spinner } from '../ui/Spinner';
import { BackIcon } from '../ui/icons';
import { CleanupMessageRow, SLICE_LABELS } from './Cleanup';

/** Messages fetched per page; "Load more" pulls the next page (ROADMAP top-priority). */
const PAGE_SIZE = 100;

export function CleanupMessages() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const slice = params.get('slice') ?? '';
  const domain = params.get('domain') ?? undefined;
  const yearsRaw = params.get('years');
  const years = yearsRaw ? Number(yearsRaw) : undefined;

  const [messages, setMessages] = useState<CleanupMessageDto[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);

  // Fetch the page starting at `offset`; offset 0 replaces (initial / param change),
  // later pages append. Guarded so a "Load more" can't fire while one is in flight.
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
          limit: PAGE_SIZE,
          offset,
        });
        setMessages((prev) => (offset === 0 ? res.messages : [...prev, ...res.messages]));
        setTotal(res.total);
        setHasMore(res.truncated);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [slice, domain, years],
  );

  useEffect(() => {
    void loadPage(0);
  }, [loadPage]);

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
      </header>

      <main className="flex-1 overflow-y-auto no-scrollbar">
        {error && messages.length === 0 ? (
          <p className="px-4 py-8 text-center text-danger">Couldn’t load messages.</p>
        ) : loading ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : messages.length === 0 ? (
          <p className="px-4 py-8 text-center text-muted">No messages here.</p>
        ) : (
          <div className="mx-auto max-w-2xl p-3">
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
              {messages.map((m) => (
                <li key={m.id}>
                  <CleanupMessageRow m={m} />
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
            <p className="px-1 pb-4 pt-3 text-center text-xs text-faint">
              Tap a message to open it. Nothing is deleted until you confirm on the Cleanup screen.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
