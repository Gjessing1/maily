import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAccounts } from '../state/data';
import { useAuth } from '../state/auth';
import { disablePush, enablePush, pushState } from '../api/push';
import { cache } from '../db/cache';
import { setPref, usePrefs, type Prefs } from '../state/prefs';
import { BackIcon } from '../ui/icons';

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

export function Settings() {
  const navigate = useNavigate();
  const accounts = useAccounts();
  const { logout } = useAuth();
  const [state, setState] = useState(pushState());
  const [busy, setBusy] = useState(false);

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
            Reading
          </p>
          <div className="border-y border-border">
            <ToggleRow
              label="Block remote images"
              hint="Hide tracking pixels until you tap “Show images” on a message."
              prefKey="blockRemoteImages"
            />
            <ToggleRow
              label="Unread at top"
              hint="Float unread messages above read ones in lists."
              prefKey="unreadAtTop"
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
          <p className="px-4 pb-1 text-xs font-medium uppercase tracking-wide text-faint">
            Storage
          </p>
          <div className="border-y border-border">
            <button
              onClick={clearCache}
              className="w-full px-4 py-3 text-left text-[15px] active:bg-surface-2"
            >
              Clear local cache
            </button>
          </div>
          <p className="px-4 pt-2 text-xs text-faint">
            The local cache is disposable — mail is re-fetched from the server.
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
    </div>
  );
}
