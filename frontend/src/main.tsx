import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { registerSW } from 'virtual:pwa-register';
import { AuthProvider } from './state/auth';
import { evictStale } from './db/cache';
import { App } from './App';
import './index.css';

// Service-worker auto-update. With injectManifest we own the registration, so
// import the generated register helper explicitly (a bare auto-register would
// NOT reload into fresh code). `immediate: true` checks for a new SW on every
// boot; on autoUpdate the helper skip-waits the new SW and reloads the page once
// it takes control — so a `docker compose pull` lands new frontend code without
// the user having to clear site data to escape the stale precached shell.
//
// Boot-time checks alone aren't enough for the INSTALLED app: a home-screen PWA
// stays resident for days and resumes from memory without re-running this module,
// so it never noticed new deploys (the "reinstall to update" problem). Re-check
// whenever the app returns to the foreground or regains network, plus hourly
// while open; `sw.js` is served no-cache, so each check really hits the server.
const SW_CHECK_MIN_GAP_MS = 60_000;
const SW_CHECK_INTERVAL_MS = 60 * 60 * 1000;
registerSW({
  immediate: true,
  onRegisteredSW(_url, registration) {
    if (!registration) return;
    let lastCheck = Date.now();
    const check = () => {
      if (!navigator.onLine || Date.now() - lastCheck < SW_CHECK_MIN_GAP_MS) return;
      lastCheck = Date.now();
      void registration.update().catch(() => undefined);
    };
    setInterval(check, SW_CHECK_INTERVAL_MS);
    window.addEventListener('online', check);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check();
    });
  },
});

// Opportunistically prune stale cache entries on boot (§6). Fire-and-forget.
void evictStale();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
