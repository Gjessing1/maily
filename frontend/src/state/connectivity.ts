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

export function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine;
}

function subscribe(listener: () => void): () => void {
  window.addEventListener('online', listener);
  window.addEventListener('offline', listener);
  return () => {
    window.removeEventListener('online', listener);
    window.removeEventListener('offline', listener);
  };
}

/** Reactive browser connectivity hint. Request failures remain authoritative, but
 * this gives the UI an immediate, consistent read-only state on an offline event. */
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribe, isOnline, () => true);
}

export const OFFLINE_READ_ONLY_MESSAGE = 'Offline — changes are disabled';
