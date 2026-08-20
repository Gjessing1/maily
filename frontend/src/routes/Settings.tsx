import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type {
  AccountDto,
  AccountSyncStatusDto,
  AddressbookSettingsDto,
  CalendarSettingsDto,
  EnrichmentStatusDto,
  ServerConfigDto,
} from '@maily/shared';
import { api } from '../api/client';
import { useAccounts, useFolders } from '../state/data';
import { useAuth } from '../state/auth';
import { useBackHandler } from '../state/backButton';
import { disablePush, enablePush, pushState } from '../api/push';
import { cache } from '../db/cache';
import { setPref, usePrefs, type Prefs } from '../state/prefs';
import { untrustImageDomain } from '../state/trustedImages';
import { checkForUpdate, type UpdateCheckResult } from '../pwa';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { DetachSection } from '../components/DetachSection';
import { BackIcon, ChevronRightIcon, CloseIcon } from '../ui/icons';
import { useMediaQuery } from '../ui/useMediaQuery';
import { SETTINGS_SECTIONS, settingsSection, type SettingsSectionId } from '../ui/settingsSections';
import {
  configureNativeServer,
  findNativeAppUpdate,
  getNativeAppInfo,
  isNativeAndroid,
  nativeDownloadUrl,
  openNativeExternal,
  type NativeAppRelease,
} from '../nativeAndroid';

/** Human-friendly cache window, e.g. 365 → "1 year", 30 → "30 days". */
function windowLabel(days: number): string {
  if (days <= 0) return 'all mail';
  if (days % 365 === 0) {
    const y = days / 365;
    return `${y} year${y > 1 ? 's' : ''}`;
  }
  return `${days} day${days > 1 ? 's' : ''}`;
}

/** iOS (iPhone/iPad) running in a browser tab — Apple blocks programmatic PWA
 * install, and Web Push needs the app on the Home Screen first (ARCHITECTURE §10). */
function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  // iPadOS 13+ reports as MacIntel; the touch-point count disambiguates it from a Mac.
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

/** Already launched from the Home Screen (installed PWA) — no install hint needed. */
function isStandalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** Human-readable byte size, e.g. 1536 → "1.5 KB", 0 → "0 B". */
function humanBytes(n: number): string {
  if (!n || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
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

/**
 * One captioned block of rows — the visual unit Settings has always used, now nested
 * inside a section instead of standing alone at the top level. `note` is the small
 * explanatory paragraph that hangs under the block.
 */
function Group({
  title,
  note,
  children,
}: {
  title?: string;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mt-6 first:mt-4">
      {title && (
        <p className="px-4 pb-1 text-xs font-medium uppercase tracking-wide text-faint">{title}</p>
      )}
      <div className="border-y border-border">{children}</div>
      {note && <div className="px-4 pt-2 text-xs text-faint">{note}</div>}
    </section>
  );
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

/**
 * Address books (ROADMAP §C, contacts Phase 1). Lists the books discovered on the
 * CardDAV server with an active toggle (which are synced/in use) and a default picker
 * (where new contacts are created). Stored server-side, so this manages its own state
 * rather than the client-owned prefs; saving re-syncs the contacts cache.
 */
function AddressBooks() {
  const [state, setState] = useState<AddressbookSettingsDto | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .addressbooks()
      .then((s) => alive && setState(s))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  if (!state) return <p className="px-4 py-3 text-sm text-faint">Loading…</p>;
  if (state.books.length === 0) {
    return (
      <p className="px-4 py-3 text-sm text-faint">
        No address books found. Configure CardDAV on the server to manage contacts.
      </p>
    );
  }

  // Persist + re-sync; optimistic, reverting on failure.
  const apply = async (active: string[], def: string | null) => {
    const prev = state;
    setBusy(true);
    setState({ ...state, active, default: def });
    try {
      setState(await api.setAddressbooks(active, def));
    } catch {
      setState(prev);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (href: string) => {
    const active = state.active.includes(href)
      ? state.active.filter((h) => h !== href)
      : [...state.active, href];
    const def =
      state.default && active.includes(state.default) ? state.default : (active[0] ?? null);
    void apply(active, def);
  };

  const setDefault = (href: string) => {
    const active = state.active.includes(href) ? state.active : [...state.active, href];
    void apply(active, href);
  };

  return (
    <>
      {state.books.map((b) => {
        const on = state.active.includes(b.href);
        const isDefault = state.default === b.href;
        return (
          <div key={b.href} className="flex items-center justify-between gap-3 px-4 py-3">
            <button
              onClick={() => toggle(b.href)}
              disabled={busy}
              role="switch"
              aria-checked={on}
              className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:opacity-50"
            >
              <Switch on={on} />
              <span className="min-w-0 truncate text-[15px]">{b.displayName}</span>
            </button>
            {on && (
              <button
                onClick={() => setDefault(b.href)}
                disabled={busy || isDefault}
                aria-pressed={isDefault}
                className={`shrink-0 rounded-full px-2.5 py-1 text-xs ${
                  isDefault ? 'bg-accent text-white' : 'bg-surface-2 text-faint active:bg-surface-3'
                }`}
              >
                {isDefault ? 'Default' : 'Set default'}
              </button>
            )}
          </div>
        );
      })}
    </>
  );
}

/**
 * Calendars (calendar integration). Lists the calendars discovered on the CalDAV
 * server with a default picker — where the reader's "Add to calendar" puts new
 * events unless another calendar is picked in the form. Stored server-side, so
 * this manages its own state rather than the client-owned prefs.
 */
function Calendars() {
  const [state, setState] = useState<CalendarSettingsDto | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .calendars()
      .then((s) => alive && setState(s))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  if (!state) return <p className="px-4 py-3 text-sm text-faint">Loading…</p>;
  if (state.calendars.length === 0) {
    return (
      <p className="px-4 py-3 text-sm text-faint">
        No calendars found. Configure CalDAV on the server to add events from mail.
      </p>
    );
  }

  // Persist the default; optimistic, reverting on failure.
  const setDefault = async (href: string) => {
    const prev = state;
    setBusy(true);
    setState({ ...state, default: href });
    try {
      setState(await api.setDefaultCalendar(href));
    } catch {
      setState(prev);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {state.calendars.map((c) => {
        const isDefault = state.default === c.href;
        return (
          <div key={c.href} className="flex items-center justify-between gap-3 px-4 py-3">
            <span className="min-w-0 truncate text-[15px]">{c.displayName}</span>
            <button
              onClick={() => setDefault(c.href)}
              disabled={busy || isDefault}
              aria-pressed={isDefault}
              className={`shrink-0 rounded-full px-2.5 py-1 text-xs ${
                isDefault ? 'bg-accent text-white' : 'bg-surface-2 text-faint active:bg-surface-3'
              }`}
            >
              {isDefault ? 'Default' : 'Set default'}
            </button>
          </div>
        );
      })}
    </>
  );
}

/** Short relative "for 12s" from an epoch-ms start (the current item's elapsed time). */
function elapsed(sinceMs: number): string {
  const s = Math.max(0, Math.round((Date.now() - sinceMs) / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * Enrichment progress. Surfaces the LLM (Ollama) backlog — the slow part the user
 * watches catch up — with a progress bar, processed/failed counts, and the live
 * "currently working on" line. Falls back to the deterministic overall count when the
 * LLM enricher isn't configured.
 */
function EnrichmentGroup({ status }: { status: EnrichmentStatusDto | null }) {
  if (status === null) {
    return (
      <Group title="Enrichment">
        <p className="px-4 py-3 text-sm text-faint">Loading…</p>
      </Group>
    );
  }

  // The LLM slice is the headline when configured; otherwise show the deterministic total.
  const slice = status.llmEnabled ? status.llm : status.overall;
  const remaining = slice.pending + slice.failed;
  const pct = slice.total > 0 ? Math.round((slice.done / slice.total) * 100) : 100;
  const cur = status.current;
  // Deterministic-only slice = overall minus the LLM slice, so the secondary line counts the
  // instant enrichers on their own and the big number can't be read as AI-summary progress.
  const instantDone = status.overall.done - status.llm.done;
  const instantTotal = status.overall.total - status.llm.total;
  const instantRemaining =
    status.overall.pending + status.overall.failed - status.llm.pending - status.llm.failed;

  return (
    <Group
      title="Enrichment"
      note="New mail is enriched on arrival; the historical backlog catches up gradually in the background so it never slows the server."
    >
      <div className="px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-[15px]">
            {status.llmEnabled ? 'AI summaries & categories' : 'Deterministic enrichers'}
          </span>
          <span className="flex shrink-0 items-center gap-1.5 text-xs">
            {cur ? (
              <>
                <span className="size-2 animate-pulse rounded-full bg-accent" />
                Working
              </>
            ) : remaining > 0 ? (
              <>
                <span className="size-2 rounded-full bg-amber-500" />
                {remaining.toLocaleString()} queued
              </>
            ) : (
              <>
                <span className="size-2 rounded-full bg-green-500" />
                Up to date
              </>
            )}
          </span>
        </div>

        {status.llmEnabled && status.model && (
          <p className="mt-0.5 text-xs text-faint">Local model · {status.model}</p>
        )}
        {!status.llmEnabled && (
          <p className="mt-0.5 text-xs text-faint">
            AI enrichment is off — set OLLAMA_URL on the server to enable summaries.
          </p>
        )}

        {/* Progress bar — done out of total for the active slice. */}
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
          <div
            className="h-full rounded-full bg-accent transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="mt-1.5 text-xs text-faint tabular-nums">
          <span className="font-medium text-fg">{slice.done.toLocaleString()}</span> of{' '}
          {slice.total.toLocaleString()} processed
          {remaining > 0 && ` · ${remaining.toLocaleString()} to go`}
          {slice.dead > 0 && ` · ${slice.dead.toLocaleString()} failed`}
        </p>

        {cur && (
          <p className="mt-1.5 truncate text-xs text-muted">
            Now: <span className="text-fg">{cur.subject || '(no subject)'}</span>{' '}
            <span className="text-faint">· {elapsed(cur.since)}</span>
          </p>
        )}

        {/* Secondary line: the instant deterministic pipeline (facts/invoice/package/…),
            labelled so its large count is never mistaken for AI-summary progress — those
            enrichers finish sub-millisecond, the AI headline above is the slow part. */}
        {status.llmEnabled && (
          <p className="mt-1.5 text-xs text-faint tabular-nums">
            Instant enrichers (no AI):{' '}
            <span className="font-medium text-fg">{instantDone.toLocaleString()}</span> of{' '}
            {instantTotal.toLocaleString()} done
            {instantRemaining > 0
              ? ` · ${instantRemaining.toLocaleString()} in the background queue`
              : ' · queue clear'}
          </p>
        )}
      </div>
    </Group>
  );
}

/**
 * Manual "update now" for the installed PWA. The periodic checks in `pwa.ts` are
 * silent and best-effort; a home-screen app that has been resident for days may
 * still be running an old bundle. `pending` reflects the server/app build mismatch
 * from the About footer, so the button reads as the fix for what's shown above it.
 */
function UpdateButton({ pending }: { pending: boolean }) {
  const [status, setStatus] = useState<'idle' | 'checking' | UpdateCheckResult>('idle');

  const run = async () => {
    setStatus('checking');
    // On 'updating' the page reloads out from under us — leave the label as-is.
    setStatus(await checkForUpdate(pending));
  };

  const label =
    status === 'checking'
      ? 'Checking…'
      : status === 'updating'
        ? 'Updating — reloading…'
        : 'Check for updates';

  return (
    <>
      <button
        onClick={() => void run()}
        disabled={status === 'checking' || status === 'updating'}
        className={`mt-2 rounded-full px-3 py-1.5 text-sm transition-colors disabled:opacity-60 ${
          pending ? 'bg-accent text-white' : 'bg-surface-2 text-fg active:bg-surface-3'
        }`}
      >
        {label}
      </button>
      {status === 'current' && <p className="mt-1.5">You’re on the latest build.</p>}
      {status === 'failed' && (
        <p className="mt-1.5 text-danger">Couldn’t check — you may be offline.</p>
      )}
      {status === 'unsupported' && (
        <p className="mt-1.5">
          No service worker on this device — reload the page to pick up a new build.
        </p>
      )}
    </>
  );
}

/** Server address and APK updates for the Capacitor shell — native builds only. */
function NativeAndroidGroup() {
  const [serverUrl, setServerUrl] = useState('');
  const [version, setVersion] = useState('');
  const [release, setRelease] = useState<NativeAppRelease | null>(null);
  const [status, setStatus] = useState('Loading Android app information…');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    void getNativeAppInfo()
      .then(async (info) => {
        if (!alive || !info) return;
        setServerUrl(info.serverUrl);
        setVersion(`${info.versionName} (${info.versionCode})`);
        const next = await findNativeAppUpdate(info);
        if (!alive) return;
        setRelease(next);
        setStatus(next ? `Maily ${next.versionName} is available.` : 'The native app is current.');
      })
      .catch((error: unknown) => {
        if (alive)
          setStatus(error instanceof Error ? error.message : 'Could not read app details.');
      });
    return () => {
      alive = false;
    };
  }, []);

  const save = async () => {
    setSaving(true);
    setStatus('Saving server address…');
    try {
      await configureNativeServer(serverUrl);
      setStatus('Restarting with the new server…');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not save the server address.');
      setSaving(false);
    }
  };

  return (
    <Group
      title="Android app"
      note="The HTTPS address is stored only on this device. Applying it restarts Maily."
    >
      <div className="space-y-3 px-4 py-3">
        <label className="block">
          <span className="mb-1 block text-sm">Maily server address</span>
          <div className="flex gap-2">
            <input
              type="url"
              inputMode="url"
              autoComplete="url"
              value={serverUrl}
              onChange={(event) => setServerUrl(event.target.value)}
              placeholder="https://mail.gjessing.io"
              className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
            />
            <button
              type="button"
              disabled={saving}
              onClick={() => void save()}
              className="rounded-full bg-surface-2 px-4 py-2 text-sm font-medium disabled:opacity-60"
            >
              Apply
            </button>
          </div>
        </label>
        <p className="text-xs text-faint">
          Installed app {version || '…'} · {status}
        </p>
        {release && (
          <button
            type="button"
            onClick={() => void openNativeExternal(nativeDownloadUrl(release))}
            className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-white"
          >
            Download {release.versionName}
          </button>
        )}
      </div>
    </Group>
  );
}

/* --------------------------------------------------------------- sections */

/** Which mailboxes exist, which of their labels reach the drawer, and locking up. */
function AccountsSection({ accounts }: { accounts: AccountDto[] | undefined }) {
  const { logout } = useAuth();
  return (
    <>
      <Group title="Accounts">
        <ul>
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
      </Group>

      <Group title="Folder menu">
        <ToggleRow
          label="Collapse mailboxes by default"
          hint="Start each account's folders collapsed in the folder menu. The inbox stays visible; expand an account any time."
          prefKey="collapseAccountsByDefault"
        />
      </Group>

      <Group
        title="Labels"
        note="Turn a label off to hide it from the folder list (e.g. Gmail’s “Important”). Nothing is deleted — the label and its mail stay on the server."
      >
        {accounts?.map((a) => (
          <AccountLabels key={a.id} account={a} />
        ))}
      </Group>

      <Group note="Signs you out on this device and returns to the password screen. Your mail, settings, and Local archive stay put — you’ll need the master password to unlock again.">
        <button
          onClick={logout}
          className="w-full px-4 py-3 text-left text-[15px] text-danger active:bg-surface-2"
        >
          Lock app
        </button>
      </Group>
    </>
  );
}

/** Theme, where a message opens on a big screen, and how dates read. */
function AppearanceSection() {
  const { readingPane } = usePrefs();
  return (
    <>
      <Group title="Theme">
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
      </Group>

      <Group title="Layout">
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
      </Group>

      <Group title="Dates">
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
      </Group>
    </>
  );
}

/** How the message list orders, pages and answers a swipe. */
function ListSection() {
  return (
    <>
      <Group title="Ordering">
        <ToggleRow
          label="Unread at top"
          hint="Float unread messages above read ones in lists."
          prefKey="unreadAtTop"
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
      </Group>

      <Group title="Gestures">
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
      </Group>
    </>
  );
}

/** Remote images, conversation grouping and when a message counts as read. */
function ReadingSection() {
  const { conversationView } = usePrefs();
  return (
    <>
      <Group title="Images">
        <ToggleRow
          label="Block remote images"
          hint="Hide tracking pixels until you tap “Show images” on a message. Trusted senders load automatically."
          prefKey="blockRemoteImages"
        />
        <TrustedImageDomains />
      </Group>

      <Group title="Conversations">
        <ToggleRow
          label="Conversation view"
          hint="Group a message and its replies into one conversation, in lists and the reader."
          prefKey="conversationView"
        />
        {conversationView && (
          <ToggleRow
            label="Newest message on top"
            hint="Show the most recent message at the top of a conversation (off = oldest first)."
            prefKey="newestMessageFirst"
          />
        )}
      </Group>

      <Group title="Marking read">
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
      </Group>
    </>
  );
}

/** Undo-send window, which account a fresh compose uses, and the signature. */
function ComposingSection({ accounts }: { accounts: AccountDto[] | undefined }) {
  const { signature } = usePrefs();
  return (
    <>
      <Group title="Sending">
        <SelectRow
          label="Undo send"
          hint="Hold a sent message this long (cancelable) before it goes out. The send commits on the server even if you close the app."
          prefKey="undoSendSeconds"
          options={[
            { value: 0, label: 'Off' },
            { value: 5, label: '5s' },
            { value: 10, label: '10s' },
            { value: 20, label: '20s' },
            { value: 30, label: '30s' },
          ]}
        />
        {(accounts?.length ?? 0) > 1 && (
          <SelectRow
            label="Default account"
            hint="Which account a fresh compose sends from. Replies keep the account their mail arrived on."
            prefKey="defaultComposeAccountId"
            options={[
              { value: '', label: 'Automatic' },
              ...(accounts ?? []).map((a) => ({
                value: a.id,
                label: a.displayName || a.email,
              })),
            ]}
          />
        )}
      </Group>

      <Group title="Signature">
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
      </Group>
    </>
  );
}

/** CardDAV books to sync, and the CalDAV calendar new events land in. */
function ContactsSection() {
  return (
    <>
      <Group
        title="Address books"
        note="Turn a book on to sync its contacts and show them in the picker. New contacts are saved to the default book."
      >
        <AddressBooks />
      </Group>

      <Group
        title="Calendars"
        note="“Add to calendar” in the reader saves events to the default calendar unless you pick another one in the form."
      >
        <Calendars />
      </Group>
    </>
  );
}

/**
 * Background-notification opt-in. One toggle, two transports underneath: Web Push on
 * the browser/PWA, and in the Android APK a background check the app runs itself (whose
 * WebView has no Push API — see api/push.ts). The iOS install prerequisite only applies
 * to the Web Push path.
 *
 * The APK's transport is worth one line of explanation to the user, because it is the
 * one thing about it that is visible: mail is checked every few minutes rather than the
 * instant it arrives. Saying so beats leaving a delay to be discovered and read as
 * "notifications are broken".
 */
function NotificationsSection() {
  const [state, setState] = useState(pushState());
  const [busy, setBusy] = useState(false);
  // Why an enable attempt didn't take (permission declined, server not configured…).
  // Cleared on the next attempt, so it never outlives the situation it describes.
  const [failure, setFailure] = useState<string | null>(null);
  // Show the manual "Add to Home Screen" guidance on iOS Safari (not yet installed):
  // Apple blocks programmatic install prompts and Web Push needs the installed PWA.
  // The Android APK registers natively, so it never needs this.
  const showIosInstall = isIos() && !isStandalone() && !isNativeAndroid();

  async function toggleNotifications() {
    setBusy(true);
    setFailure(null);
    try {
      if (state === 'granted') {
        await disablePush();
        // Permission itself can't be revoked programmatically; reflect unsubscribe.
        setState(pushState());
      } else {
        const result = await enablePush();
        setState(result.ok ? 'granted' : pushState());
        if (!result.ok && result.reason) setFailure(result.reason);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Group
      note={
        failure ??
        (state === 'denied' ? 'Notifications are blocked in your browser settings.' : undefined)
      }
    >
      {showIosInstall && (
        <div className="px-4 py-3">
          <p className="text-[15px]">Install maily on your Home Screen</p>
          <p className="mt-1 text-xs text-faint">
            Background notifications on iPhone/iPad need the app installed. In Safari, tap the Share
            button, then “Add to Home Screen”. Open maily from the new icon and enable notifications
            here.
          </p>
        </div>
      )}
      {showIosInstall ? null : state === 'unsupported' ? (
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
      {state === 'granted' && isNativeAndroid() && (
        <p className="border-t border-line px-4 py-3 text-xs text-faint">
          Maily checks for new mail every few minutes in the background — more often while the
          screen is on. Nothing runs in between, so the app doesn’t need a permanent notification in
          your shade.
        </p>
      )}
    </Group>
  );
}

/**
 * Per-account IMAP state and the enrichment queue. Both drift as the worker processes
 * mail, so this polls — but only while the section is open, which is a direct win from
 * the drill-down: Settings used to poll both endpoints every 5s whatever you came for.
 */
function SyncSection() {
  const [sync, setSync] = useState<AccountSyncStatusDto[] | null>(null);
  const [enrich, setEnrich] = useState<EnrichmentStatusDto | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      api
        .syncStatus()
        .then((s) => alive && setSync(s))
        .catch(() => undefined);
      api
        .enrichmentStatus()
        .then((e) => alive && setEnrich(e))
        .catch(() => undefined);
    };
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <>
      <Group
        title="Sync"
        note={
          <>
            {sync && sync.length > 0 && (
              <p>
                Local storage used:{' '}
                <span className="font-medium text-fg">
                  {humanBytes(sync.reduce((sum, a) => sum + (a.contentBytes ?? 0), 0))}
                </span>
              </p>
            )}
            <p className="pt-2">
              Counts are messages cached locally per folder. This is on-disk size here — archived
              message sources plus message bodies and any downloaded attachments — not your
              mailbox’s server-side total. It’s normally far smaller because attachments are fetched
              on demand, and older mail stays on the server until you open it.
            </p>
          </>
        }
      >
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
                  {` · ${humanBytes(acc.contentBytes)}`}
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
      </Group>

      <EnrichmentGroup status={enrich} />
    </>
  );
}

/** The browser's offline cache, the server's sync window, and detach-to-local. */
function StorageSection({
  accounts,
  config,
}: {
  accounts: AccountDto[] | undefined;
  config: ServerConfigDto | null;
}) {
  const [confirmClear, setConfirmClear] = useState(false);

  async function clearCache() {
    await cache.delete();
    location.reload();
  }

  return (
    <>
      <Group
        title="Offline cache"
        note={
          <>
            This only clears mail stored in <strong>this browser</strong>. It does{' '}
            <strong>not</strong> touch the server or your Local archive below — everything
            re-downloads from the server on reload. The one thing it can’t bring back is mail that
            was already purged from the server itself.
          </>
        }
      >
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
      </Group>

      <DetachSection accounts={accounts ?? []} />

      <ConfirmDialog
        open={confirmClear}
        title="Clear local cache?"
        message="This wipes only the copy of mail stored in this browser — the server and your Local archive are untouched, and everything re-downloads on reload. Safe to do anytime."
        confirmLabel="Clear cache"
        danger
        onConfirm={() => {
          setConfirmClear(false);
          void clearCache();
        }}
        onCancel={() => setConfirmClear(false)}
      />
    </>
  );
}

/** Which build runs here, whether the server has a newer one, and the Android shell. */
function SystemSection({ config }: { config: ServerConfigDto | null }) {
  const stale = !!config && config.buildId !== __BUILD_ID__;
  return (
    <>
      {/* About: the bundled build id is what the service worker is actually serving —
          comparing it against the server's proves whether an update has landed here. */}
      <Group title="About">
        <div className="px-4 py-3 text-xs text-faint">
          <p>
            maily · build <span className="font-mono">{__BUILD_ID__}</span> ·{' '}
            {new Date(__BUILT_AT__).toLocaleString()}
          </p>
          {stale && (
            <p className="mt-1 text-accent">
              Server is on build <span className="font-mono">{config.buildId}</span> — an app update
              is waiting.
            </p>
          )}
          <UpdateButton pending={stale} />
        </div>
      </Group>

      {isNativeAndroid() && <NativeAndroidGroup />}
    </>
  );
}

/* ------------------------------------------------------------------ shell */

/**
 * Settings, grouped by task instead of stacked in one scroll (see
 * `ui/settingsSections.ts`). A phone shows the section menu and drills into one at a
 * time — Android's Back pops the drill first, like every other overlay in the app —
 * while a wide window keeps the menu as a sidebar beside the open section.
 *
 * Only the open section is mounted, so a section's fetches and polling start when it
 * is reached and stop when it is left.
 */
export function Settings() {
  const navigate = useNavigate();
  const accounts = useAccounts();
  const wide = useMediaQuery('(min-width: 768px)');
  const [section, setSection] = useState<SettingsSectionId | null>(null);
  const [config, setConfig] = useState<ServerConfigDto | null>(null);

  // Server config is static for the session — fetch once, shared by Storage and System.
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

  const opened = settingsSection(section);
  // A wide window always has a section on screen; a phone starts on the bare menu.
  const current = opened ?? (wide ? (SETTINGS_SECTIONS[0] ?? null) : null);
  const drilled = !wide && opened !== null;

  // Back out of the drill before leaving Settings — same contract as the drawer/dialogs.
  useBackHandler(drilled, () => setSection(null));

  return (
    <div className="flex h-full flex-col">
      <header className="safe-top sticky top-0 z-10 flex items-center gap-1 border-b border-border bg-bg/85 px-2 py-2 backdrop-blur">
        <button
          onClick={() => (drilled ? setSection(null) : navigate(-1))}
          className="rounded-full p-2 active:bg-surface-2"
          aria-label={drilled ? 'Back to settings' : 'Back'}
        >
          <BackIcon />
        </button>
        <h1 className="flex-1 truncate text-lg font-semibold">
          {drilled && opened ? opened.label : 'Settings'}
        </h1>
      </header>

      <div className="flex min-h-0 flex-1">
        {!drilled && (
          <nav
            aria-label="Settings sections"
            className={`overflow-y-auto no-scrollbar ${
              wide ? 'w-72 shrink-0 border-r border-border py-2' : 'flex-1 py-2'
            }`}
          >
            {SETTINGS_SECTIONS.map((s) => (
              <button
                key={s.id}
                onClick={() => setSection(s.id)}
                aria-current={current?.id === s.id ? 'page' : undefined}
                className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left active:bg-surface-2 ${
                  wide && current?.id === s.id ? 'bg-surface-2' : ''
                }`}
              >
                <span className="min-w-0">
                  <span className="block text-[15px]">{s.label}</span>
                  <span className="mt-0.5 block text-xs text-faint">{s.hint}</span>
                </span>
                {!wide && <ChevronRightIcon className="size-5 shrink-0 text-faint" />}
              </button>
            ))}
          </nav>
        )}

        {current && (wide || drilled) && (
          <main className="min-w-0 flex-1 overflow-y-auto no-scrollbar pb-10">
            {/* Capped so a wide window doesn't stretch rows and hint text across the
                whole pane; a no-op at phone widths. */}
            <div className="mx-auto w-full max-w-2xl">
              {current.id === 'accounts' && <AccountsSection accounts={accounts} />}
              {current.id === 'appearance' && <AppearanceSection />}
              {current.id === 'list' && <ListSection />}
              {current.id === 'reading' && <ReadingSection />}
              {current.id === 'composing' && <ComposingSection accounts={accounts} />}
              {current.id === 'contacts' && <ContactsSection />}
              {current.id === 'notifications' && <NotificationsSection />}
              {current.id === 'sync' && <SyncSection />}
              {current.id === 'storage' && <StorageSection accounts={accounts} config={config} />}
              {current.id === 'system' && <SystemSection config={config} />}
            </div>
          </main>
        )}
      </div>
    </div>
  );
}
