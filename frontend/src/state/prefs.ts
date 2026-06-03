/**
 * Tiny localStorage-backed UI preferences. Client-only display prefs — never
 * secrets and never server state (those live in env / SQLite). Reactive via
 * useSyncExternalStore so flipping a toggle in Settings updates every mounted view.
 */
import { useSyncExternalStore } from 'react';

/** How absolute dates are rendered. 'system' follows the browser locale. */
export type DateFormat = 'system' | 'dmy' | 'mdy' | 'ymd';

/** Colour theme. 'system' follows the OS `prefers-color-scheme`. */
export type Theme = 'system' | 'light' | 'dark';

/** Action bound to a list-row swipe. 'read' toggles seen/unseen; 'none' disables the swipe. */
export type SwipeAction = 'none' | 'read' | 'delete';

/**
 * Reading-pane placement (Gmail-style). 'none' opens messages full-screen;
 * 'right'/'below' show a master-detail split. The split only engages on wide
 * screens — narrow/mobile always falls back to full-screen open.
 */
export type ReadingPane = 'none' | 'right' | 'below';

export interface Prefs {
  /** Block remote images in mail bodies by default (privacy). Per-message override in the Reader. */
  blockRemoteImages: boolean;
  /** Sort unread above read in list views (secondary to newest-first). */
  unreadAtTop: boolean;
  /** Date display format for list/reader timestamps. */
  dateFormat: DateFormat;
  /** Colour theme; 'system' tracks the OS preference live. */
  theme: Theme;
  /** Messages fetched per page before pagination kicks in. */
  pageSize: number;
  /**
   * When to auto-mark a message read on open: `-1` never, `0` immediately,
   * `>0` after that many seconds of viewing.
   */
  markReadSeconds: number;
  /** Action committed by swiping a list row right (left→right). */
  swipeRight: SwipeAction;
  /** Action committed by swiping a list row left (right→left). */
  swipeLeft: SwipeAction;
  /** Days of mail to retain in the volatile IndexedDB cache before eviction (§6). */
  clientCacheDays: number;
  /** Reading-pane placement on wide screens (Gmail-style split). */
  readingPane: ReadingPane;
  /** Plain-text signature appended to new messages (empty = none). */
  signature: string;
  /** Append the signature automatically when composing. */
  signatureEnabled: boolean;
}

const DEFAULTS: Prefs = {
  blockRemoteImages: false,
  unreadAtTop: false,
  dateFormat: 'system',
  theme: 'system',
  pageSize: 100,
  markReadSeconds: 0,
  swipeRight: 'read',
  swipeLeft: 'delete',
  clientCacheDays: 30,
  readingPane: 'none',
  signature: '',
  signatureEnabled: false,
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
