import { registerSW } from 'virtual:pwa-register';

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

let registration: ServiceWorkerRegistration | undefined;
let applyUpdate: ((reloadPage?: boolean) => Promise<void>) | undefined;

/** Register the service worker. Call once, from the app entrypoint. */
export function initPwa(): void {
  applyUpdate = registerSW({
    immediate: true,
    onRegisteredSW(_url, reg) {
      if (!reg) return;
      registration = reg;
      let lastCheck = Date.now();
      const check = () => {
        if (!navigator.onLine || Date.now() - lastCheck < SW_CHECK_MIN_GAP_MS) return;
        lastCheck = Date.now();
        void reg.update().catch(() => undefined);
      };
      setInterval(check, SW_CHECK_INTERVAL_MS);
      window.addEventListener('online', check);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
    },
  });
}

export type UpdateCheckResult =
  /** A newer bundle was found and is being applied — the page reloads itself. */
  | 'updating'
  /** The server has nothing newer than what this session is already running. */
  | 'current'
  /** No service worker (dev server, private mode, unsupported browser). */
  | 'unsupported'
  /** The check itself failed — offline, or the server was unreachable. */
  | 'failed';

/** Wait for an installing worker to finish, so we can tell "downloading a new
 * build" apart from "nothing new". Resolves false if it never reaches `installed`. */
function awaitInstalled(worker: ServiceWorker): Promise<boolean> {
  return new Promise((resolve) => {
    const done = () => {
      if (worker.state === 'installed' || worker.state === 'activated') resolve(true);
      else if (worker.state === 'redundant') resolve(false);
      else return;
      worker.removeEventListener('statechange', done);
    };
    worker.addEventListener('statechange', done);
    done();
  });
}

/**
 * User-triggered update check (Settings → About). The periodic checks above are
 * best-effort and silent; this is the escape hatch when the About footer says the
 * server is on a newer build and you want it *now* rather than on the next resume.
 *
 * `knownStale` means the About footer already saw the server on a different build
 * than this bundle. That distinguishes the two ways to be behind: a worker still
 * needs fetching (handled below), or one already activated while this tab kept
 * running its old JS — in which case there is nothing left to install and a plain
 * reload is the fix. Without that fallback the button dead-ends on "you're on the
 * latest build" while the footer insists an update is waiting.
 *
 * On success this reloads the page, so callers should not expect to run after it.
 */
export async function checkForUpdate(knownStale = false): Promise<UpdateCheckResult> {
  if (!registration || !applyUpdate) return 'unsupported';
  try {
    await registration.update();
  } catch {
    return 'failed';
  }
  // `update()` resolves once the new sw.js has been fetched and compared. A byte
  // difference puts a worker in `installing`; identical bytes leave both empty.
  const pending = registration.installing ?? registration.waiting;
  if (!pending) {
    if (!knownStale) return 'current';
    // Nothing to install, but we know this page is behind: the new shell is
    // already precached, so a reload swaps into it.
    window.location.reload();
    return 'updating';
  }
  if (registration.installing && !(await awaitInstalled(registration.installing))) {
    // Install failed (precache fetch error) — nothing to activate.
    return 'failed';
  }
  // Skip-waits the new worker and reloads once it controls the page.
  void applyUpdate(true);
  return 'updating';
}
