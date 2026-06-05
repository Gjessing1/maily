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
registerSW({ immediate: true });

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
