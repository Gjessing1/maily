import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { onSocketReconnect } from './api/socket';
import { useAuth } from './state/auth';
import { useSignals } from './state/signals';
import { useTheme } from './state/theme';
import { hydratePrefs } from './state/prefs';
import { prefetchCleanupDashboard } from './state/cleanupDash';
import { isPopout, onWindowMessage, sweepHandoffs } from './ui/popout';
import { showNotice, stageSend } from './state/undo';
import { useOnlineStatus } from './state/connectivity';
import { SyncBar } from './components/SyncBar';
import { UndoSnackbar } from './components/UndoSnackbar';
import { Login } from './routes/Login';
import { Home } from './routes/Home';
import { findNativeAppUpdate, getNativeAppInfo } from './nativeAndroid';

// Home is the app shell's primary view and stays eager. Everything else is loaded
// on demand; Workbox still precaches the emitted chunks, so they remain available
// to an installed PWA without making first paint parse the whole application.
const Reader = lazy(() => import('./routes/Reader').then((m) => ({ default: m.Reader })));
const Compose = lazy(() => import('./routes/Compose').then((m) => ({ default: m.Compose })));
const Search = lazy(() => import('./routes/Search').then((m) => ({ default: m.Search })));
const Settings = lazy(() => import('./routes/Settings').then((m) => ({ default: m.Settings })));
const Contacts = lazy(() => import('./routes/Contacts').then((m) => ({ default: m.Contacts })));
const ContactDetail = lazy(() =>
  import('./routes/ContactDetail').then((m) => ({ default: m.ContactDetail })),
);
const Cleanup = lazy(() => import('./routes/Cleanup').then((m) => ({ default: m.Cleanup })));
const CleanupMessages = lazy(() =>
  import('./routes/CleanupMessages').then((m) => ({ default: m.CleanupMessages })),
);
const Outbox = lazy(() => import('./routes/Outbox').then((m) => ({ default: m.Outbox })));

function LoadingShell() {
  return (
    <div className="flex h-full flex-col" aria-label="Loading maily">
      <div className="safe-top h-14 border-b border-border bg-bg" />
      <div className="flex-1 px-4 py-3">
        {[0, 1, 2, 3, 4].map((row) => (
          <div
            key={row}
            className="flex animate-pulse items-center gap-3 border-b border-border/60 py-3"
          >
            <div className="size-10 shrink-0 rounded-full bg-surface-2" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="h-3 w-2/5 rounded bg-surface-2" />
              <div className="h-3 w-4/5 rounded bg-surface" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function OfflineUnavailable({ signedOut = false }: { signedOut?: boolean }) {
  return (
    <div className="safe-top safe-bottom flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-xl font-semibold">You’re offline</h1>
      <p className="max-w-sm text-sm text-muted">
        {signedOut
          ? 'Connect once to unlock maily before using its cached mail offline.'
          : 'This section needs the server. Cached folders and downloaded messages are still available.'}
      </p>
      {!signedOut && (
        <Link to="/" className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-white">
          Back to cached mail
        </Link>
      )}
    </div>
  );
}

function OnlineOnly({ children }: { children: ReactNode }) {
  const online = useOnlineStatus();
  return online ? children : <OfflineUnavailable />;
}

export function App() {
  const { authed, ready } = useAuth();
  const online = useOnlineStatus();

  // Signal handling must live above the routes so flag/new-mail updates land in
  // the cache regardless of which screen is mounted.
  const { progress } = useSignals();

  // Pull server-side preferences once authenticated so settings are consistent
  // across devices (the server is the source of truth; local storage is a cache).
  // Re-hydrate (throttled) when the app comes back to the foreground or the
  // socket reconnects, so a preference flipped on another device shows up here
  // without a full app restart. Pending local edits win (see hydratePrefs).
  useEffect(() => {
    if (!authed) return;
    void hydratePrefs();
    let last = Date.now();
    const rehydrate = () => {
      if (Date.now() - last < 30_000) return;
      last = Date.now();
      void hydratePrefs();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') rehydrate();
    };
    document.addEventListener('visibilitychange', onVisible);
    const offReconnect = onSocketReconnect(rehydrate);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      offReconnect();
    };
  }, [authed]);

  // The hosted UI updates with the server; only notify when the native container
  // itself has a newer signed APK. Installation is available in Settings.
  useEffect(() => {
    if (!authed) return;
    const timer = setTimeout(() => {
      void getNativeAppInfo()
        .then(async (info) => findNativeAppUpdate(info))
        .then((release) => {
          if (release) showNotice(`Maily ${release.versionName} is ready in Settings`);
        })
        .catch(() => undefined);
    }, 2000);
    return () => clearTimeout(timer);
  }, [authed]);

  // Detached windows (reader/composer popouts) hand their undo window back here: a popout
  // that sends closes immediately, so its own "Undo send" snackbar would never be seen.
  // Only the main window listens — a popout must not re-arm what it just delegated.
  useEffect(() => {
    if (!authed || isPopout()) return;
    sweepHandoffs(); // clear prefills parked for popouts that never opened
    return onWindowMessage((message) => {
      if (message.type === 'staged-send') void stageSend(message.outboxId, message.dueAt);
      else showNotice(message.message);
    });
  }, [authed]);

  // Once the initial screens have had the network to themselves, warm the Cleanup
  // Dashboard cache in the background so entering it later renders instantly.
  useEffect(() => {
    if (!authed) return;
    const t = setTimeout(prefetchCleanupDashboard, 4000);
    return () => clearTimeout(t);
  }, [authed]);

  // Reflect the resolved theme onto <html> (drives the CSS token overrides) and
  // the PWA status-bar colour. The pre-paint script in index.html sets the initial
  // attribute; this keeps it in sync when the pref or OS preference changes.
  const theme = useTheme();
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', theme === 'light' ? '#ffffff' : '#0b0b0f');
  }, [theme]);

  // Hold the first paint until the auth-config probe resolves so an external-SSO
  // deployment never flashes the login screen before auto-authing.
  if (!ready) return <LoadingShell />;
  if (!authed) return online ? <Login /> : <OfflineUnavailable signedOut />;

  return (
    <div className="app-safe-shell flex h-full flex-col">
      <div className="fixed inset-x-0 top-0 z-50">
        <SyncBar progress={progress} />
      </div>
      {!online && (
        <div className="shrink-0 bg-accent-soft px-3 py-1.5 text-center text-xs font-medium text-accent">
          Offline · cached mail is read-only
        </div>
      )}
      <div className="min-h-0 flex-1">
        <Suspense fallback={<LoadingShell />}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/m/:id" element={<Reader />} />
            <Route
              path="/compose"
              element={
                <OnlineOnly>
                  <Compose />
                </OnlineOnly>
              }
            />
            <Route
              path="/search"
              element={
                <OnlineOnly>
                  <Search />
                </OnlineOnly>
              }
            />
            <Route
              path="/cleanup"
              element={
                <OnlineOnly>
                  <Cleanup />
                </OnlineOnly>
              }
            />
            <Route
              path="/cleanup/messages"
              element={
                <OnlineOnly>
                  <CleanupMessages />
                </OnlineOnly>
              }
            />
            <Route
              path="/outbox"
              element={
                <OnlineOnly>
                  <Outbox />
                </OnlineOnly>
              }
            />
            <Route path="/settings" element={<Settings />} />
            <Route
              path="/contacts"
              element={
                <OnlineOnly>
                  <Contacts />
                </OnlineOnly>
              }
            />
            <Route
              path="/contacts/:uid"
              element={
                <OnlineOnly>
                  <ContactDetail />
                </OnlineOnly>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </div>
      <UndoSnackbar />
    </div>
  );
}
