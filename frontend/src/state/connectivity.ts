import { useSyncExternalStore } from 'react';

/**
 * A successful authenticated visit makes this browser eligible to open its local
 * mail cache when the server is unreachable. This is not a replacement credential:
 * every server request is still authenticated normally, and offline mode is strictly
 * read-only. It only prevents the already-downloaded PWA from hiding data that is
 * already present in this origin's IndexedDB.
 */
const OFFLINE_ACCESS_KEY = 'maily.offlineAccess';

export function hasOfflineAccess(): boolean {
  try {
    return localStorage.getItem(OFFLINE_ACCESS_KEY) === 'true';
  } catch {
    return false;
  }
}

export function grantOfflineAccess(): void {
  try {
    localStorage.setItem(OFFLINE_ACCESS_KEY, 'true');
  } catch {
    // Storage can be unavailable in private/restricted contexts. The current
    // online session still works; it just cannot bootstrap offline next time.
  }
}

export function revokeOfflineAccess(): void {
  try {
    localStorage.removeItem(OFFLINE_ACCESS_KEY);
  } catch {
    // Best-effort for the same restricted-storage case as grantOfflineAccess.
  }
}

/** The device's own network state. Gates whether a request is attempted at all. */
export function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine;
}

/**
 * Whether the maily server answered the last time we asked. Distinct from
 * `isOnline()`: a phone with a perfectly good network still cannot reach a home server
 * that is down, and the tunnel/proxy in front of it then answers with its own HTML
 * error page. That is offline as far as the user is concerned, so the app goes
 * read-only on its cached mail exactly as it does without a network — rather than
 * printing the proxy's markup as an error over the list.
 *
 * Set by the API client (api/client.ts), which also probes for the server's return.
 */
let serverReachable = true;
const listeners = new Set<() => void>();
const restoredListeners = new Set<() => void>();

export function isServerReachable(): boolean {
  return serverReachable;
}

export function markServerUnreachable(): void {
  if (!serverReachable) return;
  serverReachable = false;
  listeners.forEach((l) => l());
}

export function markServerReachable(): void {
  if (serverReachable) return;
  serverReachable = true;
  listeners.forEach((l) => l());
  restoredListeners.forEach((l) => l());
}

/** Test seam: module state outlives a test. */
export function resetServerReachable(): void {
  serverReachable = true;
}

/** The device has a network and the server is answering: changes are possible. */
export function isConnected(): boolean {
  return isOnline() && serverReachable;
}

/**
 * Run `listener` whenever the app gets its server back — the device regaining a
 * network, or the server answering again after being unreachable. Data hooks refetch
 * on it. Returns the unsubscribe.
 */
export function onReconnect(listener: () => void): () => void {
  window.addEventListener('online', listener);
  restoredListeners.add(listener);
  return () => {
    window.removeEventListener('online', listener);
    restoredListeners.delete(listener);
  };
}

function subscribe(listener: () => void): () => void {
  window.addEventListener('online', listener);
  window.addEventListener('offline', listener);
  listeners.add(listener);
  return () => {
    window.removeEventListener('online', listener);
    window.removeEventListener('offline', listener);
    listeners.delete(listener);
  };
}

/** Reactive "can we talk to the server" — false offline AND while the server is
 * unreachable, so every screen drops into the same read-only cached state for both. */
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribe, isConnected, () => true);
}

export type Connectivity = 'online' | 'offline' | 'unreachable';

function connectivity(): Connectivity {
  if (!isOnline()) return 'offline';
  return serverReachable ? 'online' : 'unreachable';
}

/** Which kind of disconnected we are, for wording the banner. */
export function useConnectivity(): Connectivity {
  return useSyncExternalStore(subscribe, connectivity, () => 'online');
}

export const OFFLINE_READ_ONLY_MESSAGE = 'Offline — changes are disabled';
