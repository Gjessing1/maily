import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AccountDto, AccountSyncStatusDto, ServerConfigDto } from '@maily/shared';
import { api } from '../api/client';
import { useAccounts, useFolders } from '../state/data';
import { useAuth } from '../state/auth';
import { disablePush, enablePush, pushState } from '../api/push';
import { cache } from '../db/cache';
import { setPref, usePrefs, type Prefs } from '../state/prefs';
import { untrustImageDomain } from '../state/trustedImages';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { BackIcon, CloseIcon } from '../ui/icons';

/** Human-friendly cache window, e.g. 365 → "1 year", 30 → "30 days". */
function windowLabel(days: number): string {
  if (days <= 0) return 'all mail';
  if (days % 365 === 0) {
    const y = days / 365;
    return `${y} year${y > 1 ? 's' : ''}`;
  }
  return `${days} day${days > 1 ? 's' : ''}`;
}

/** Compact "x min ago" for the last-sync line. */
function timeAgo(ms: number | null): string {
  if (!ms) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Keys of Prefs whose value is a boolean — the only ones ToggleRow can drive. */
type BooleanPrefKey = {
  [K in keyof Prefs]: Prefs[K] extends boolean ? K : never;
}[keyof Prefs];

/** A labelled on/off switch backed by a boolean preference. */
function ToggleRow({
  label,
  hint,
  prefKey,
}: {
  label: string;
  hint?: string;
  prefKey: BooleanPrefKey;
}) {
  const value = usePrefs()[prefKey];
  return (
    <button
      onClick={() => setPref(prefKey, !value)}
      role="switch"
      aria-checked={value}
      className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left active:bg-surface-2"
    >
      <span className="min-w-0">
        <span className="block text-[15px]">{label}</span>
        {hint && <span className="mt-0.5 block text-xs text-faint">{hint}</span>}
      </span>
      <span
        className={`relative h-6 w-10 shrink-0 rounded-full transition-colors ${value ? 'bg-accent' : 'bg-surface-2'}`}
      >
        <span
          className={`absolute top-0.5 size-5 rounded-full bg-white transition-transform ${value ? 'translate-x-4' : 'translate-x-0.5'}`}
        />
      </span>
    </button>
  );
}

/** A labelled segmented selector backed by a preference with a fixed option set. */
function SelectRow<K extends keyof Prefs>({
  label,
  hint,
  prefKey,
  options,
}: {
  label: string;
  hint?: string;
  prefKey: K;
  options: { value: Prefs[K]; label: string }[];
}) {
  const value = usePrefs()[prefKey];
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <span className="min-w-0">
        <span className="block text-[15px]">{label}</span>
        {hint && <span className="mt-0.5 block text-xs text-faint">{hint}</span>}
      </span>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <button
            key={String(o.value)}
            onClick={() => setPref(prefKey, o.value)}
            aria-pressed={value === o.value}
            className={`rounded-full px-3 py-1.5 text-sm transition-colors ${
              value === o.value
                ? 'bg-accent text-white'
                : 'bg-surface-2 text-faint active:bg-surface-3'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** A compact on/off pill, used for the per-label visibility switches. */
function Switch({ on }: { on: boolean }) {
  return (
    <span
      className={`relative h-6 w-10 shrink-0 rounded-full transition-colors ${on ? 'bg-accent' : 'bg-surface-2'}`}
    >
      <span
        className={`absolute top-0.5 size-5 rounded-full bg-white transition-transform ${on ? 'translate-x-4' : 'translate-x-0.5'}`}
      />
    </span>
  );
}

/** Removable chips for sender domains whose remote images load automatically.
 * Only rendered when the list is non-empty; entries are added from the reader's
 * "Always trust …" action on the blocked-images bar. */
function TrustedImageDomains() {
  const domains = usePrefs().trustedImageDomains;
  if (domains.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <span className="text-[15px]">Trusted image senders</span>
      <div className="flex flex-wrap gap-1.5">
        {domains.map((d) => (
          <button
            key={d}
            onClick={() => untrustImageDomain(d)}
            className="flex items-center gap-1.5 rounded-full bg-surface-2 py-1.5 pl-3 pr-2 text-sm text-fg active:bg-surface-3"
            aria-label={`Stop trusting ${d}`}
          >
            <span className="truncate">{d}</span>
            <CloseIcon className="size-4 shrink-0 text-faint" />
          </button>
        ))}
      </div>
    </div>
  );
}

/** Per-account list of custom labels with a show/hide switch (ROADMAP §B). Hidden
 * labels drop out of the folder drawer but are never deleted server-side. */
function AccountLabels({ account }: { account: AccountDto }) {
  const folders = useFolders(account.id);
  const hidden = usePrefs().hiddenFolderIds;
  const labels = (folders ?? []).filter((f) => f.role === 'custom');
  if (!labels.length) return null;

  const setHidden = (id: string, hide: boolean) =>
    setPref('hiddenFolderIds', hide ? [...hidden, id] : hidden.filter((x) => x !== id));

  return (
    <div>
      <p className="px-4 pt-3 text-xs text-faint">{account.displayName || account.email}</p>
      {labels.map((f) => {
        const shown = !hidden.includes(f.id);
        return (
          <button
            key={f.id}
            onClick={() => setHidden(f.id, shown)}
            role="switch"
            aria-checked={shown}
            className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left active:bg-surface-2"
          >
            <span className="min-w-0 truncate text-[15px] capitalize">{f.name}</span>
            <Switch on={shown} />
          </button>
        );
      })}
    </div>
  );
}

export function Settings() {
  const navigate = useNavigate();
  const accounts = useAccounts();
  const { logout } = useAuth();
  const { signature, readingPane } = usePrefs();
  const [state, setState] = useState(pushState());
  const [busy, setBusy] = useState(false);
  const [sync, setSync] = useState<AccountSyncStatusDto[] | null>(null);
  const [config, setConfig] = useState<ServerConfigDto | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  // Server config is static for the session — fetch once.
  useEffect(() => {
    let alive = true;
    api
      .config()
      .then((c) => alive && setConfig(c))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // Poll sync status while Settings is open (cheap; counts drift during a sync pass).
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .syncStatus()
        .then((s) => alive && setSync(s))
        .catch(() => undefined);
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  async function toggleNotifications() {
    setBusy(true);
    try {
      if (state === 'granted') {
        await disablePush();
        // Permission itself can't be revoked programmatically; reflect unsubscribe.
        setState(pushState());
      } else {
        const ok = await enablePush();
        setState(ok ? 'granted' : pushState());
      }
    } finally {
      setBusy(false);
    }
  }

  async function clearCache() {
    await cache.delete();
    location.reload();
  }

  return (
    <div className="flex h-full flex-col">
      <header className="safe-top sticky top-0 z-10 flex items-center gap-1 border-b border-border bg-bg/85 px-2 py-2 backdrop-blur">
        <button
          onClick={() => navigate(-1)}
          className="rounded-full p-2 active:bg-surface-2"
          aria-label="Back"
        >
          <BackIcon />
        </button>
        <h1 className="flex-1 text-lg font-semibold">Settings</h1>
      </header>

      <main className="flex-1 overflow-y-auto no-scrollbar">
        <section className="mt-4">
          <p className="px-4 pb-1 text-xs font-medium uppercase tracking-wide text-faint">
            Accounts
          </p>
          <ul className="border-y border-border">
            {accounts?.map((a) => (
              <li key={a.id} className="flex flex-col px-4 py-3">
                <span className="text-[15px]">{a.displayName || a.email}</span>
                <span className="text-xs text-faint">
                  {a.email} · {a.provider}
                </span>
              </li>
            ))}
            {!accounts?.length && (
              <li className="px-4 py-3 text-sm text-faint">No accounts configured.</li>
            )}
          </ul>
        </section>

        <section className="mt-6">
          <p className="px-4 pb-1 text-xs font-medium uppercase tracking-wide text-faint">
            Appearance
          </p>
          <div className="border-y border-border">
            <SelectRow
              label="Theme"
              hint="System follows your device’s light/dark setting."
              prefKey="theme"
              options={[
                { value: 'system', label: 'System' },
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
              ]}
            />
          </div>
        </section>

        <section className="mt-6">
          <p className="px-4 pb-1 text-xs font-medium uppercase tracking-wide text-faint">
            Reading
          </p>
          <div className="border-y border-border">
            <ToggleRow
              label="Block remote images"
              hint="Hide tracking pixels until you tap “Show images” on a message. Trusted senders load automatically."
              prefKey="blockRemoteImages"
            />
            <TrustedImageDomains />
            <ToggleRow
              label="Unread at top"
              hint="Float unread messages above read ones in lists."
              prefKey="unreadAtTop"
            />
            <SelectRow
              label="Mark as read on open"
              hint="When opening a message should it count as read."
              prefKey="markReadSeconds"
              options={[
                { value: -1, label: 'Never' },
                { value: 0, label: 'Immediately' },
                { value: 2, label: 'After 2s' },
                { value: 5, label: 'After 5s' },
                { value: 10, label: 'After 10s' },
              ]}
            />
          </div>
        </section>

        <section className="mt-6">
          <p className="px-4 pb-1 text-xs font-medium uppercase tracking-wide text-faint">Layout</p>
          <div className="border-y border-border">
            <SelectRow
              label="Reading pane"
              hint="Where a message opens on larger screens. On phones it always opens full-screen."
              prefKey="readingPane"
              options={[
                { value: 'none', label: 'No split' },
                { value: 'right', label: 'Right of list' },
                { value: 'below', label: 'Below list' },
              ]}
            />
            {readingPane !== 'none' && (
              <SelectRow
                label="Split from"
                hint="Minimum window width for the split to appear. Narrower windows open messages full-screen — handy when the browser's side tab strip leaves little room."
                prefKey="readingPaneMinWidth"
                options={[
                  { value: 768, label: 'Compact (768)' },
                  { value: 1024, label: 'Standard (1024)' },
                  { value: 1280, label: 'Wide (1280)' },
                ]}
              />
            )}
          </div>
        </section>

        <section className="mt-6">
          <p className="px-4 pb-1 text-xs font-medium uppercase tracking-wide text-faint">Labels</p>
          <div className="border-y border-border">
            {accounts?.map((a) => (
              <AccountLabels key={a.id} account={a} />
            ))}
          </div>
          <p className="px-4 pt-2 text-xs text-faint">
            Turn a label off to hide it from the folder list (e.g. Gmail’s “Important”). Nothing is
            deleted — the label and its mail stay on the server.
          </p>
        </section>

        <section className="mt-6">
          <p className="px-4 pb-1 text-xs font-medium uppercase tracking-wide text-faint">
            Gestures
          </p>
          <div className="border-y border-border">
            <SelectRow
              label="Swipe right"
              hint="Action when you swipe a message row left → right."
              prefKey="swipeRight"
              options={[
                { value: 'read', label: 'Toggle read' },
                { value: 'delete', label: 'Delete' },
                { value: 'none', label: 'Off' },
              ]}
            />
            <SelectRow
              label="Swipe left"
              hint="Action when you swipe a message row right → left."
              prefKey="swipeLeft"
              options={[
                { value: 'read', label: 'Toggle read' },
                { value: 'delete', label: 'Delete' },
                { value: 'none', label: 'Off' },
              ]}
            />
          </div>
        </section>

        <section className="mt-6">
          <p className="px-4 pb-1 text-xs font-medium uppercase tracking-wide text-faint">
            Display
          </p>
          <div className="border-y border-border">
            <SelectRow
              label="Date format"
              hint="How message dates are shown in lists and the reader."
              prefKey="dateFormat"
              options={[
                { value: 'system', label: 'System' },
                { value: 'dmy', label: 'DD.MM.YYYY' },
                { value: 'mdy', label: 'MM/DD/YYYY' },
                { value: 'ymd', label: 'YYYY-MM-DD' },
              ]}
            />
            <SelectRow
              label="Messages per page"
              hint="How many to load before fetching more."
              prefKey="pageSize"
              options={[
                { value: 50, label: '50' },
                { value: 100, label: '100' },
                { value: 200, label: '200' },
              ]}
            />
          </div>
        </section>

        <section className="mt-6">
          <p className="px-4 pb-1 text-xs font-medium uppercase tracking-wide text-faint">
            Composing
          </p>
          <div className="border-y border-border">
            <ToggleRow
              label="Append signature"
              hint="Add your signature to the bottom of new messages."
              prefKey="signatureEnabled"
            />
            <div className="px-4 py-3">
              <label className="mb-2 block text-[15px]">Signature</label>
              <textarea
                value={signature}
                onChange={(e) => setPref('signature', e.target.value)}
                rows={4}
                placeholder="Lars Gjessing&#10;Sent from maily"
                className="w-full resize-none rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none placeholder:text-faint"
              />
            </div>
          </div>
        </section>

        <section className="mt-6">
          <p className="px-4 pb-1 text-xs font-medium uppercase tracking-wide text-faint">
            Notifications
          </p>
          <div className="border-y border-border">
            {state === 'unsupported' ? (
              <p className="px-4 py-3 text-sm text-faint">
                Background notifications aren’t supported here. On iOS, install the app to your Home
                Screen first.
              </p>
            ) : (
              <button
                onClick={toggleNotifications}
                disabled={busy || state === 'denied'}
                className="flex w-full items-center justify-between px-4 py-3 text-left active:bg-surface-2 disabled:opacity-50"
              >
                <span className="text-[15px]">Background notifications</span>
                <span className="text-sm text-accent">
                  {state === 'granted' ? 'On' : state === 'denied' ? 'Blocked' : 'Enable'}
                </span>
              </button>
            )}
          </div>
          {state === 'denied' && (
            <p className="px-4 pt-2 text-xs text-faint">
              Notifications are blocked in your browser settings.
            </p>
          )}
        </section>

        <section className="mt-6">
          <p className="px-4 pb-1 text-xs font-medium uppercase tracking-wide text-faint">Sync</p>
          <div className="border-y border-border">
            {sync === null ? (
              <p className="px-4 py-3 text-sm text-faint">Loading…</p>
            ) : sync.length === 0 ? (
              <p className="px-4 py-3 text-sm text-faint">No active sync engines.</p>
            ) : (
              sync.map((acc) => {
                // "Syncing" until every folder has completed its first pass; once all
                // are synced and the IDLE link is up, the account is unambiguously
                // caught up. Offline trumps both.
                const syncing = acc.folders.some((f) => !f.synced);
                const status = !acc.connected
                  ? { dot: 'bg-faint', label: 'Offline' }
                  : syncing
                    ? { dot: 'bg-amber-500 animate-pulse', label: 'Syncing…' }
                    : { dot: 'bg-green-500', label: 'Up to date' };
                return (
                  <div key={acc.accountId} className="px-4 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-[15px]">{acc.email}</span>
                      <span className="flex shrink-0 items-center gap-1.5 text-xs">
                        <span className={`size-2 rounded-full ${status.dot}`} />
                        {status.label}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-faint">
                      {acc.connected && !syncing
                        ? `Synced ${timeAgo(acc.lastSyncAt)}`
                        : `Last sync ${timeAgo(acc.lastSyncAt)}`}
                    </p>
                    <ul className="mt-2 space-y-0.5">
                      {acc.folders
                        .filter((f) => f.cached > 0 || f.synced)
                        .map((f) => (
                          <li
                            key={f.id}
                            className="flex items-center justify-between gap-2 text-xs text-muted"
                          >
                            <span className="min-w-0 truncate capitalize">{f.name}</span>
                            <span className="shrink-0 tabular-nums text-faint">
                              {f.cached.toLocaleString()}
                              {!f.synced && ' · syncing…'}
                            </span>
                          </li>
                        ))}
                    </ul>
                  </div>
                );
              })
            )}
          </div>
          <p className="px-4 pt-2 text-xs text-faint">
            Counts are messages cached locally per folder. Mail outside the cache window stays on
            the server and is fetched on demand.
          </p>
        </section>

        <section className="mt-6">
          <p className="px-4 pb-1 text-xs font-medium uppercase tracking-wide text-faint">
            Storage
          </p>
          <div className="border-y border-border">
            <SelectRow
              label="Keep on this device"
              hint="How long mail stays in this browser’s offline cache before it’s evicted."
              prefKey="clientCacheDays"
              options={[
                { value: 7, label: '7 days' },
                { value: 30, label: '30 days' },
                { value: 90, label: '90 days' },
                { value: 365, label: '1 year' },
              ]}
            />
            <div className="flex items-center justify-between gap-4 px-4 py-3">
              <span className="min-w-0">
                <span className="block text-[15px]">Server cache window</span>
                <span className="mt-0.5 block text-xs text-faint">
                  How far back the server syncs into its local archive (set on the server).
                </span>
              </span>
              <span className="shrink-0 text-sm text-faint">
                {config ? windowLabel(config.cacheWindowDays) : '…'}
              </span>
            </div>
            <button
              onClick={() => setConfirmClear(true)}
              className="w-full px-4 py-3 text-left text-[15px] active:bg-surface-2"
            >
              Clear local cache
            </button>
          </div>
          <p className="px-4 pt-2 text-xs text-faint">
            The local cache is a disposable copy of mail that’s still on the server. Clearing it
            re-downloads live mail, but can’t restore anything already archived or purged
            server-side.
          </p>
        </section>

        <section className="mt-6 mb-10">
          <div className="border-y border-border">
            <button
              onClick={logout}
              className="w-full px-4 py-3 text-left text-[15px] text-danger active:bg-surface-2"
            >
              Lock app
            </button>
          </div>
        </section>
      </main>

      <ConfirmDialog
        open={confirmClear}
        title="Clear local cache?"
        message="This wipes mail stored on this device. Anything still on the server re-downloads, but mail already archived or purged server-side can’t be recovered here."
        confirmLabel="Clear cache"
        danger
        onConfirm={() => {
          setConfirmClear(false);
          void clearCache();
        }}
        onCancel={() => setConfirmClear(false)}
      />
    </div>
  );
}
