import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './state/auth';
import { useSignals } from './state/signals';
import { useTheme } from './state/theme';
import { hydratePrefs } from './state/prefs';
import { prefetchCleanupDashboard } from './state/cleanupDash';
import { SyncBar } from './components/SyncBar';
import { UndoSnackbar } from './components/UndoSnackbar';
import { Login } from './routes/Login';
import { Home } from './routes/Home';
import { Reader } from './routes/Reader';
import { Compose } from './routes/Compose';
import { Search } from './routes/Search';
import { Settings } from './routes/Settings';
import { Contacts } from './routes/Contacts';
import { ContactDetail } from './routes/ContactDetail';
import { Cleanup } from './routes/Cleanup';
import { CleanupMessages } from './routes/CleanupMessages';

export function App() {
  const { authed, ready } = useAuth();

  // Signal handling must live above the routes so flag/new-mail updates land in
  // the cache regardless of which screen is mounted.
  const { progress } = useSignals();

  // Pull server-side preferences once authenticated so settings are consistent
  // across devices (the server is the source of truth; local storage is a cache).
  useEffect(() => {
    if (authed) void hydratePrefs();
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
  if (!ready) return null;
  if (!authed) return <Login />;

  return (
    <>
      <div className="fixed inset-x-0 top-0 z-50">
        <SyncBar progress={progress} />
      </div>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/m/:id" element={<Reader />} />
        <Route path="/compose" element={<Compose />} />
        <Route path="/search" element={<Search />} />
        <Route path="/cleanup" element={<Cleanup />} />
        <Route path="/cleanup/messages" element={<CleanupMessages />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/contacts" element={<Contacts />} />
        <Route path="/contacts/:uid" element={<ContactDetail />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <UndoSnackbar />
    </>
  );
}
