/**
 * Tiny localStorage-backed UI preferences. Client-only display prefs — never
 * secrets and never server state (those live in env / SQLite). Reactive via
 * useSyncExternalStore so flipping a toggle in Settings updates every mounted view.
 */
import { useSyncExternalStore } from 'react';

/** How absolute dates are rendered. 'system' follows the browser locale. */
export type DateFormat = 'system' | 'dmy' | 'mdy' | 'ymd';

export interface Prefs {
  /** Block remote images in mail bodies by default (privacy). Per-message override in the Reader. */
  blockRemoteImages: boolean;
  /** Sort unread above read in list views (secondary to newest-first). */
  unreadAtTop: boolean;
  /** Date display format for list/reader timestamps. */
  dateFormat: DateFormat;
  /** Messages fetched per page before pagination kicks in. */
  pageSize: number;
}

const DEFAULTS: Prefs = {
  blockRemoteImages: false,
  unreadAtTop: false,
  dateFormat: 'system',
  pageSize: 100,
};

const KEY = 'maily.prefs';

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

let current = load();
const listeners = new Set<() => void>();

export function getPrefs(): Prefs {
  return current;
}

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  current = { ...current, [key]: value };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Best-effort: storage may be full or disabled — prefs just won't persist.
  }
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reactive read of the whole prefs object. */
export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, getPrefs, getPrefs);
}
