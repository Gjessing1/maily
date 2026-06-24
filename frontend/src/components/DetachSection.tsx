import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountDto, DetachPreviewDto, DetachRequest, DetachStatusDto } from '@maily/shared';
import { api } from '../api/client';
import { ConfirmDialog } from './ConfirmDialog';

/** Human-readable byte size, e.g. 1536 → "1.5 KB". */
function humanBytes(n: number): string {
  if (!n || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

const fmtDate = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short' }) : '—';

/** Start of a `yyyy-mm-dd` day in the browser's local timezone, epoch ms. */
const dayStartMs = (d: string): number => {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(y, m - 1, day).getTime();
};
/** End of a `yyyy-mm-dd` day, exclusive — next local midnight (DST-safe) — so the whole day is included. */
const dayEndMs = (d: string): number => {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(y, m - 1, day + 1).getTime();
};

/**
 * Settings panel for "detach to local": delete an account's mail from the provider while
 * keeping the full copy on this server. Always preview (dry-run) before the destructive
 * run; the run moves each safe message's provider copy to Trash and flags it `local_only`,
 * leaving it in the inbox served from the local archive. Mail with no local `.eml` is
 * skipped (deleting it would lose its attachments). Polls job status while it runs.
 */
export function DetachSection({ accounts }: { accounts: AccountDto[] }) {
  const [accountId, setAccountId] = useState<string>('');
  const [scope, setScope] = useState<'all' | 'cutoff' | 'range'>('all');
  const [cutoff, setCutoff] = useState<string>(''); // yyyy-mm-dd
  const [from, setFrom] = useState<string>(''); // yyyy-mm-dd, inclusive
  const [to, setTo] = useState<string>(''); // yyyy-mm-dd, inclusive day
  const [preview, setPreview] = useState<DetachPreviewDto | null>(null);
  const [status, setStatus] = useState<DetachStatusDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Default the account once the list loads.
  useEffect(() => {
    const first = accounts[0];
    if (!accountId && first) setAccountId(first.id);
  }, [accounts, accountId]);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.detach.status());
    } catch {
      /* transient — keep last status */
    }
  }, []);

  // Initial status, then poll every 2s only while a run is in flight.
  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);
  useEffect(() => {
    const running = status?.state === 'running';
    if (running && !pollRef.current) {
      pollRef.current = setInterval(() => void refreshStatus(), 2000);
    } else if (!running && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [status?.state, refreshStatus]);

  if (!accounts.length) return null;

  const buildRequest = (): DetachRequest | null => {
    if (scope === 'cutoff') {
      if (!cutoff) return null;
      return { accountId, scope, cutoffMs: dayStartMs(cutoff) };
    }
    if (scope === 'range') {
      if (!from && !to) return null;
      return {
        accountId,
        scope,
        fromMs: from ? dayStartMs(from) : undefined,
        toMs: to ? dayEndMs(to) : undefined,
      };
    }
    return { accountId, scope };
  };

  const runDryRun = async (): Promise<void> => {
    const req = buildRequest();
    if (!req) {
      setError(scope === 'range' ? 'Pick a from and/or to date.' : 'Pick a cutoff date first.');
      return;
    }
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      setPreview(await api.detach.dryRun(req));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runDetach = async (): Promise<void> => {
    const req = buildRequest();
    if (!req) return;
    setConfirmOpen(false);
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.detach.run(req));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const running = status?.state === 'running';
  const canDetach = !!preview && preview.safe > 0 && !running && !busy;
  const accountEmail = accounts.find((a) => a.id === accountId)?.email ?? 'this account';

  return (
    <section className="mt-6">
      <p className="px-4 pb-1 text-xs font-medium uppercase tracking-wide text-faint">
        Local archive
      </p>
      <div className="border-y border-border">
        {/* Account picker — only meaningful with more than one account. */}
        {accounts.length > 1 && (
          <label className="flex items-center justify-between gap-4 px-4 py-3">
            <span className="text-[15px]">Account</span>
            <select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              disabled={running}
              className="max-w-[55%] truncate rounded bg-surface-2 px-2 py-1 text-sm"
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.email}
                </option>
              ))}
            </select>
          </label>
        )}

        {/* Scope: all mail vs older-than-cutoff. */}
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <span className="text-[15px]">Which mail</span>
          <div className="flex items-center gap-2 text-sm">
            <button
              onClick={() => setScope('all')}
              disabled={running}
              className={`rounded px-2 py-1 ${scope === 'all' ? 'bg-accent text-white' : 'bg-surface-2 text-fg'}`}
            >
              All mail
            </button>
            <button
              onClick={() => setScope('cutoff')}
              disabled={running}
              className={`rounded px-2 py-1 ${scope === 'cutoff' ? 'bg-accent text-white' : 'bg-surface-2 text-fg'}`}
            >
              Older than…
            </button>
            <button
              onClick={() => setScope('range')}
              disabled={running}
              className={`rounded px-2 py-1 ${scope === 'range' ? 'bg-accent text-white' : 'bg-surface-2 text-fg'}`}
            >
              Date range
            </button>
          </div>
        </div>
        {scope === 'cutoff' && (
          <label className="flex items-center justify-between gap-4 px-4 py-3">
            <span className="text-[15px]">Cutoff date</span>
            <input
              type="date"
              value={cutoff}
              onChange={(e) => setCutoff(e.target.value)}
              disabled={running}
              className="rounded bg-surface-2 px-2 py-1 text-sm"
            />
          </label>
        )}
        {scope === 'range' && (
          <>
            <label className="flex items-center justify-between gap-4 px-4 py-3">
              <span className="text-[15px]">From</span>
              <input
                type="date"
                value={from}
                max={to || undefined}
                onChange={(e) => setFrom(e.target.value)}
                disabled={running}
                className="rounded bg-surface-2 px-2 py-1 text-sm"
              />
            </label>
            <label className="flex items-center justify-between gap-4 px-4 py-3">
              <span className="text-[15px]">To</span>
              <input
                type="date"
                value={to}
                min={from || undefined}
                onChange={(e) => setTo(e.target.value)}
                disabled={running}
                className="rounded bg-surface-2 px-2 py-1 text-sm"
              />
            </label>
            <p className="px-4 pb-1 text-xs text-faint">
              Both dates are inclusive. Set the same day in both to detach a single date; leave one
              blank for an open-ended range.
            </p>
          </>
        )}

        <button
          onClick={() => void runDryRun()}
          disabled={busy || running}
          className="w-full px-4 py-3 text-left text-[15px] active:bg-surface-2 disabled:opacity-50"
        >
          {busy && !running ? 'Checking…' : 'Preview (dry run)'}
        </button>

        {/* Dry-run result. */}
        {preview && (
          <div className="border-t border-border px-4 py-3 text-sm">
            <p>
              In scope: <strong>{preview.total}</strong> · Safe to detach:{' '}
              <strong>{preview.safe}</strong>
              {preview.unsafe > 0 && (
                <>
                  {' '}
                  · <span className="text-danger">Skipped (no local copy): {preview.unsafe}</span>
                </>
              )}
            </p>
            {preview.safe > 0 && (
              <p className="mt-1 text-faint">
                {fmtDate(preview.oldest)} – {fmtDate(preview.newest)} ·{' '}
                {humanBytes(preview.estimatedBytes)} of local archive
              </p>
            )}
            {preview.unsafe > 0 && (
              <p className="mt-1 text-xs text-faint">
                Skipped (kept on the provider): {preview.unsafeSamples.join('; ')}
                {preview.unsafe > preview.unsafeSamples.length ? '…' : ''}
              </p>
            )}
          </div>
        )}

        <button
          onClick={() => setConfirmOpen(true)}
          disabled={!canDetach}
          className="w-full border-t border-border px-4 py-3 text-left text-[15px] text-danger active:bg-surface-2 disabled:opacity-40"
        >
          Detach {preview ? preview.safe : ''} from {scope === 'all' ? 'provider' : 'provider'} →
          keep local
        </button>
      </div>

      {/* Live progress / last result. */}
      {status && status.state !== 'idle' && (
        <p className="px-4 pt-2 text-xs text-faint">
          {running
            ? `Detaching… ${status.processed}/${status.total} (${status.detached} done${status.failed ? `, ${status.failed} failed` : ''})`
            : status.state === 'done'
              ? `Done: detached ${status.detached}, skipped ${status.skippedUnsafe} (no local copy)${status.failed ? `, ${status.failed} failed` : ''}.`
              : status.state === 'error'
                ? `Stopped: ${status.error ?? 'error'}. Already-detached mail is kept; re-run to continue.`
                : ''}
        </p>
      )}
      {error && <p className="px-4 pt-2 text-xs text-danger">{error}</p>}
      <p className="px-4 pt-2 text-xs text-faint">
        Removes mail from {accountEmail} but keeps the complete copy here. The provider copy is
        moved to its Trash (recoverable there ~30 days). Detached mail stays in your inbox with a
        “Local” tag; new mail keeps syncing to both places.
      </p>

      <ConfirmDialog
        open={confirmOpen}
        title="Detach mail to local only?"
        message={`This moves ${preview?.safe ?? 0} message(s) on ${accountEmail} to the provider Trash (recoverable there ~30 days) and keeps the full copy on this server. Start with a small cutoff if you’re unsure.`}
        confirmLabel="Detach"
        danger
        onConfirm={() => void runDetach()}
        onCancel={() => setConfirmOpen(false)}
      />
    </section>
  );
}
