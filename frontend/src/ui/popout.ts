/**
 * Detached windows ("open in a new window") for the reader and the composer — a
 * desktop affordance: keep a reply open while browsing other mail in the main window.
 *
 * Design notes:
 * - A popout is just the normal SPA loaded in a `window.open` popup, so every route
 *   works unchanged. `window.name` marks the window (it survives in-window navigation
 *   *and* reloads, unlike router state); `?popout=1` is a belt-and-braces fallback.
 * - Naming windows per target (`maily-popout:m:<id>`) makes a second click on the same
 *   message focus the existing window instead of spawning duplicates.
 * - The composer's prefill normally travels in router state, which `window.open` can't
 *   carry. It's handed over through `localStorage` instead (synchronous, same-origin,
 *   consumed once) and then re-parked in history state by the popout so a reload of the
 *   detached composer still restores it.
 * - Popups can't be relied on for the *undo* snackbar: a composer that sends and closes
 *   would take its own snackbar with it. Sends staged in a popout are broadcast to the
 *   main window over a BroadcastChannel, which arms the snackbar there instead.
 *
 * Mobile has no window management to speak of, so the affordance is gated on a wide,
 * fine-pointer viewport (`usePopoutCapable`) and simply doesn't render on phones.
 */
import { useMediaQuery } from './useMediaQuery';

const NAME_PREFIX = 'maily-popout:';
const HANDOFF_PREFIX = 'maily.popout.handoff.';
const CHANNEL = 'maily.windows';

/** True when this window is itself a detached popout. Latched once at module load. */
const POPOUT =
  typeof window !== 'undefined' &&
  (window.name.startsWith(NAME_PREFIX) ||
    new URLSearchParams(window.location.search).get('popout') === '1');

export function isPopout(): boolean {
  return POPOUT;
}

/**
 * Whether detached windows make sense here: a wide viewport driven by a real pointer.
 * Touch/phone layouts get no popout buttons at all.
 */
export function usePopoutCapable(): boolean {
  return useMediaQuery('(min-width: 900px) and (pointer: fine)');
}

/**
 * Open `path` in a detached window. Reusing `key` focuses an already-open window for
 * the same target rather than opening a second one. Returns false when the browser
 * blocked the popup, so callers can fall back to normal in-app navigation.
 */
export function openPopout(
  path: string,
  key: string,
  size: { width: number; height: number } = { width: 780, height: 900 },
): boolean {
  const width = Math.min(size.width, window.screen.availWidth);
  const height = Math.min(size.height, window.screen.availHeight);
  // Offset from the current window so the popout doesn't land exactly on top of it.
  const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - width) / 2 + 40));
  const top = Math.max(0, Math.round(window.screenY + 40));
  const url = `${path}${path.includes('?') ? '&' : '?'}popout=1`;
  const win = window.open(
    url,
    `${NAME_PREFIX}${key}`,
    `popup=yes,width=${width},height=${height},left=${left},top=${top}`,
  );
  if (!win) return false;
  win.focus();
  return true;
}

/**
 * Re-key this popout so it answers to a different target. A reader popout that navigates
 * to the composer must stop being the window `openPopout('/m/<id>')` reuses, or opening
 * that message again would navigate the window away from an in-progress reply.
 */
export function claimPopoutName(key: string): void {
  if (!POPOUT) return;
  window.name = `${NAME_PREFIX}${key}`;
}

/** Close this popout (no-op in a normal tab — `window.close` only works on opened windows). */
export function closePopout(): void {
  window.close();
}

// --- Composer hand-off -------------------------------------------------------

/**
 * Park a composer prefill for a popout to pick up, returning the id to put in the URL.
 * Values are plain JSON (addresses, subject, quoted HTML, attachment refs).
 */
export function putHandoff(payload: unknown): string | null {
  const id = crypto.randomUUID();
  try {
    localStorage.setItem(HANDOFF_PREFIX + id, JSON.stringify({ at: Date.now(), payload }));
    return id;
  } catch {
    // Quota (a very large forward) — the caller falls back to in-app navigation.
    return null;
  }
}

/** Read and remove a parked prefill. Returns null for an unknown/consumed id. */
export function takeHandoff<T>(id: string | null): T | null {
  if (!id) return null;
  const key = HANDOFF_PREFIX + id;
  const raw = localStorage.getItem(key);
  localStorage.removeItem(key);
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as { payload: T }).payload;
  } catch {
    return null;
  }
}

/**
 * Drop hand-off records left behind by windows that never opened (blocked/crashed).
 * Age-gated: another tab may have parked one moments ago for a popout still loading,
 * and sweeping that would silently empty a detached composer.
 */
export function sweepHandoffs(maxAgeMs = 60_000): void {
  const cutoff = Date.now() - maxAgeMs;
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (!key?.startsWith(HANDOFF_PREFIX)) continue;
    let at = 0;
    try {
      at = (JSON.parse(localStorage.getItem(key) ?? '{}') as { at?: number }).at ?? 0;
    } catch {
      // Unparseable — treat as stale.
    }
    if (at < cutoff) localStorage.removeItem(key);
  }
}

// --- Cross-window messages ---------------------------------------------------

export type WindowMessage =
  | { type: 'staged-send'; outboxId: string; dueAt: number }
  | { type: 'notice'; message: string };

/** Send a message to the app's other windows (used by popouts to reach the main window). */
export function postToWindows(message: WindowMessage): void {
  if (typeof BroadcastChannel === 'undefined') return;
  const ch = new BroadcastChannel(CHANNEL);
  ch.postMessage(message);
  ch.close();
}

/** Subscribe to messages from other windows. Returns an unsubscribe function. */
export function onWindowMessage(handler: (message: WindowMessage) => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => undefined;
  const ch = new BroadcastChannel(CHANNEL);
  ch.onmessage = (e: MessageEvent<WindowMessage>) => handler(e.data);
  return () => ch.close();
}
