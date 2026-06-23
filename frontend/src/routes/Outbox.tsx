/**
 * Outbox / Scheduled sends. Lists the sends still queued in the server-owned outbox — both the
 * brief undo-send holds and any "Send later" schedules — and lets the user cancel them before
 * they fire. The queue lives on the server, so what's shown here reflects what will actually go
 * out whether or not this device stays open. Cancel returns 409 if the send already committed
 * (the runner claimed it first), in which case we just refresh the list.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { OutboxEntry } from '@maily/shared';
import { api } from '../api/client';
import { Spinner } from '../ui/Spinner';
import { BackIcon, ClockIcon } from '../ui/icons';

function formatDue(ms: number): string {
  return new Date(ms).toLocaleString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function Outbox() {
  const navigate = useNavigate();
  const [entries, setEntries] = useState<OutboxEntry[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { entries } = await api.listOutbox();
      setEntries(entries);
    } catch {
      setEntries([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Keep the countdown/list honest while open — sends fire server-side on their own.
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  async function cancel(id: string) {
    setBusy(id);
    try {
      await api.cancelOutbox(id);
    } catch {
      // 409 (already sent) or transient — the refresh below reflects the real state.
    } finally {
      setBusy(null);
      void refresh();
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="safe-top sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-bg/85 px-2 py-2 backdrop-blur">
        <button
          onClick={() => navigate(-1)}
          className="rounded-full p-2 active:bg-surface-2"
          aria-label="Back"
        >
          <BackIcon />
        </button>
        <h1 className="flex-1 text-lg font-semibold">Outbox</h1>
      </header>

      <main className="flex-1 overflow-y-auto no-scrollbar">
        {entries === null ? (
          <div className="flex justify-center py-10">
            <Spinner className="size-5" />
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-16 text-center text-faint">
            <ClockIcon className="size-7 opacity-50" />
            <p className="text-sm">No queued or scheduled sends.</p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {entries.map((e) => (
              <li key={e.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] text-fg">{e.subject || '(no subject)'}</p>
                  <p className="truncate text-xs text-faint">To: {(e.to ?? []).join(', ')}</p>
                  <p className="mt-0.5 text-xs text-accent">Sends {formatDue(e.dueAt)}</p>
                </div>
                <button
                  type="button"
                  onClick={() => void cancel(e.id)}
                  disabled={busy === e.id}
                  className="rounded-full border border-border px-3 py-1.5 text-sm text-fg active:bg-surface-2 disabled:opacity-40"
                >
                  Cancel
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
