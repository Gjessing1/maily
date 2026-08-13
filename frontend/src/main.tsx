import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './state/auth';
import { evictStale } from './db/cache';
import { initPwa } from './pwa';
import { App } from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);

// Let React replace the static first-paint shell before registration, cache pruning,
// and storage bookkeeping compete for the main thread / IndexedDB connection.
const finishBoot = () => {
  initPwa();
  void evictStale();
  // Ask the browser not to evict downloaded message bodies under storage pressure.
  // This is best-effort and silent; unsupported/private contexts simply decline.
  void navigator.storage?.persist?.().catch(() => false);
};

if ('requestIdleCallback' in window) {
  window.requestIdleCallback(finishBoot, { timeout: 1500 });
} else {
  setTimeout(finishBoot, 0);
}
