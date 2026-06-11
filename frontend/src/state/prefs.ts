/**
 * UI preferences. Display-only prefs (never secrets) that the user expects to be
 * "global" — the same on every device. The server (SQLite) is the source of truth
 * and `localStorage` is a fast offline cache: we render from the cache instantly,
 * hydrate from the server on login, and push every change back (debounced).
 * Reactive via useSyncExternalStore so flipping a toggle updates every mounted view.
 */
import { useSyncExternalStore } from 'react';
import { api } from '../api/client';

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

/**
 * Cleanup aggressiveness preset (ROADMAP Phase 6b.2). A 1-click profile over the
 * deterministic cleanup slices: how old "cold storage" must be and whether the
 * never-replied heuristic is surfaced at all. 'strict' keeps the most.
 */
export type CleanupPreset = 'strict' | 'balanced' | 'aggressive';

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
  /**
   * Minimum viewport width (px) for the split reading pane to engage. Below it,
   * messages open full-screen — so a narrow window (e.g. a laptop with the
   * browser's vertical tab strip eating horizontal space) isn't forced into a
   * cramped two-pane layout.
   */
  readingPaneMinWidth: number;
  /** Plain-text signature appended to new messages (empty = none). */
  signature: string;
  /** Append the signature automatically when composing. */
  signatureEnabled: boolean;
  /**
   * Account a fresh compose defaults to sending from (account id). Empty = automatic
   * (first account). Replies/forwards ignore this — they keep the account the source
   * mail arrived on.
   */
  defaultComposeAccountId: string;
  /** Folder/label ids the user has hidden from the drawer (e.g. Gmail's "Important"). */
  hiddenFolderIds: string[];
  /**
   * Start each account's folder section collapsed in the folder menu (the inbox row
   * stays pinned/visible). A view default — the user can still expand/collapse any
   * account for the session.
   */
  collapseAccountsByDefault: boolean;
  /**
   * Sender domains whose remote images load automatically even when blocking is on
   * (e.g. "github.com"). Lowercased host part of the From address. Empty = trust none.
   */
  trustedImageDomains: string[];
  /** Cleanup Dashboard aggressiveness profile (ROADMAP Phase 6b.2). */
  cleanupPreset: CleanupPreset;
}

const DEFAULTS: Prefs = {
  blockRemoteImages: false,
  unreadAtTop: true,
  dateFormat: 'system',
  theme: 'system',
  pageSize: 100,
  markReadSeconds: 0,
  swipeRight: 'read',
  swipeLeft: 'delete',
  clientCacheDays: 30,
  readingPane: 'none',
  readingPaneMinWidth: 1024,
  signature: '',
  signatureEnabled: false,
  defaultComposeAccountId: '',
  hiddenFolderIds: [],
  collapseAccountsByDefault: false,
  trustedImageDomains: [],
  cleanupPreset: 'balanced',
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

function saveLocal(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Best-effort: storage may be full or disabled — the offline cache just won't persist.
  }
}

function notify(): void {
  for (const l of listeners) l();
}

// Debounced write-back to the server so rapid edits (e.g. typing a signature)
// coalesce into one request. The whole prefs object is sent; the server owns it.
let pushTimer: ReturnType<typeof setTimeout> | undefined;
function schedulePush(): void {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    void api.putSettings(current as unknown as Record<string, unknown>).catch(() => {
      // Offline / unauthorized — local cache holds the change; it re-syncs next save.
    });
  }, 600);
}

export function getPrefs(): Prefs {
  return current;
}

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  current = { ...current, [key]: value };
  saveLocal();
  notify();
  schedulePush();
}

/**
 * Adopt the server's preferences on login (they're the cross-device source of
 * truth). A fresh server with nothing stored yet is seeded from this device's
 * local cache, so existing users' prefs migrate up on first run. Best-effort:
 * offline/unauthorized just keeps the local cache.
 */
export async function hydratePrefs(): Promise<void> {
  try {
    const server = await api.getSettings();
    if (server && Object.keys(server).length > 0) {
      current = { ...DEFAULTS, ...(server as Partial<Prefs>) };
      saveLocal();
      notify();
    } else {
      await api.putSettings(current as unknown as Record<string, unknown>);
    }
  } catch {
    // Keep local prefs; they push up on the next successful save.
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reactive read of the whole prefs object. */
export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, getPrefs, getPrefs);
}
