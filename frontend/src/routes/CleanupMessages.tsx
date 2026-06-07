/**
 * Cleanup drill-down screen (ROADMAP Phase 6b review surface). A dedicated, full-screen
 * list of the individual messages a delete-eligible slice would trash — opened for a single
 * sender that has too many messages to expand inline on the Cleanup card. Read-only: it
 * lists what's in scope and links each message to the reader; nothing is deleted here (the
 * confirm/execute step stays on the Cleanup screen). The same safety + slice predicates run
 * server-side, so what's shown is exactly what an execute would move.
 */
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { CleanupMessagesDto } from '@maily/shared';
import { api } from '../api/client';
import { Spinner } from '../ui/Spinner';
import { BackIcon } from '../ui/icons';
import { CleanupMessageRow, SLICE_LABELS } from './Cleanup';

export function CleanupMessages() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const slice = params.get('slice') ?? '';
  const domain = params.get('domain') ?? undefined;
  const yearsRaw = params.get('years');
  const years = yearsRaw ? Number(yearsRaw) : undefined;

  const [data, setData] = useState<CleanupMessagesDto | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    setData(null);
    setError(false);
    void api.cleanup
      .messages({ slice, domain, years, limit: 500 })
      .then(setData)
      .catch(() => setError(true));
  }, [slice, domain, years]);

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
            {data && ` · ${data.total.toLocaleString()} message${data.total === 1 ? '' : 's'}`}
          </p>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto no-scrollbar">
        {error ? (
          <p className="px-4 py-8 text-center text-danger">Couldn’t load messages.</p>
        ) : data === null ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : data.messages.length === 0 ? (
          <p className="px-4 py-8 text-center text-muted">No messages here.</p>
        ) : (
          <div className="mx-auto max-w-2xl p-3">
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
              {data.messages.map((m) => (
                <li key={m.id}>
                  <CleanupMessageRow m={m} />
                </li>
              ))}
            </ul>
            {data.truncated && (
              <p className="px-1 py-3 text-center text-xs text-faint">
                Showing the first {data.messages.length.toLocaleString()} of{' '}
                {data.total.toLocaleString()}.
              </p>
            )}
            <p className="px-1 pb-4 pt-2 text-center text-xs text-faint">
              Tap a message to open it. Nothing is deleted until you confirm on the Cleanup screen.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
