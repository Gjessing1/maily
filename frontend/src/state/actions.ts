/**
 * Shared Action Center count — drives the nav badge and stays in sync with the hub.
 *
 * A tiny external store (not Dexie: proposals are a small, server-authoritative list,
 * not bulk mail) so the badge and the Actions page share one number. Refreshed on the
 * `action:ready` socket signal (an enricher surfaced a new offer) and adjustable
 * optimistically when the user resolves one on the page.
 */
import { useSyncExternalStore } from 'react';
import { api } from '../api/client';
import { onSignal } from '../api/socket';

let count = 0;
const listeners = new Set<() => void>();

function set(n: number): void {
  if (n === count) return;
  count = n;
  listeners.forEach((l) => l());
}

/** Pull the authoritative live-offer count from the backend. */
export async function refreshActionCount(): Promise<void> {
  try {
    const res = await api.actionCount();
    set(res.count);
  } catch {
    // Transient (offline / 401 handled by the client) — leave the last known count.
  }
}

/** Optimistically nudge the count (e.g. after approve/dismiss removes one). */
export function adjustActionCount(delta: number): void {
  set(Math.max(0, count + delta));
}

let wired = false;
function ensureWired(): void {
  if (wired) return;
  wired = true;
  void refreshActionCount();
  onSignal((s) => {
    if (s.type === 'action:ready') void refreshActionCount();
  });
}

/** Live count of pending Action Center offers. */
export function useActionCount(): number {
  ensureWired();
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => count,
  );
}
