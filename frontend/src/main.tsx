import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './state/auth';
import { evictStale } from './db/cache';
import { initPwa } from './pwa';
import { App } from './App';
import './index.css';

initPwa();

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
