/**
 * UI preferences: display choices, never secrets. Most follow the user across devices — the
 * server stores them and `localStorage` is a fast offline cache, so we render from the cache
 * instantly, hydrate from the server, and push each change back as a merge patch of only the keys
 * that changed, so two devices editing different prefs never overwrite each other. The
 * {@link DEVICE_ONLY} prefs stay on this device. Settings the server acts on (cleanup keyword
 * lists, the undo-send window) aren't prefs; they live in `state/serverSettings.ts`.
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

/** A delete-eligible cleanup slice id (matches the backend's DELETE_SLICES). */
export type CleanupSliceId = 'large' | 'cold-storage' | 'newsletters';

export interface Prefs {
  /** Block remote images in mail bodies by default (privacy). Per-message override in the Reader. */
  blockRemoteImages: boolean;
  /** Sort unread above read in list views (secondary to newest-first). */
  unreadAtTop: boolean;
  /**
   * Group a message and its replies into a single conversation, both in list views
   * (one row per thread) and in the reader (stacked, collapsible messages). Off =
   * every message is its own row, the classic flat list.
   */
  conversationView: boolean;
  /**
   * Within a conversation, order the most recent message first (top). Off puts the
   * oldest first (chronological, Gmail-style). Only relevant with conversationView on.
   */
  newestMessageFirst: boolean;
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
  /** Days of mail to retain in the volatile IndexedDB cache before eviction (§6). Device-only. */
  clientCacheDays: number;
  /** Reading-pane placement on wide screens (Gmail-style split). */
  readingPane: ReadingPane;
  /**
   * Minimum viewport width (px) for the split reading pane to engage. Below it,
   * messages open full-screen — so a narrow window (e.g. a laptop with the
   * browser's vertical tab strip eating horizontal space) isn't forced into a
   * cramped two-pane layout. Device-only.
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
  /**
   * Which delete-eligible cleanup slices are surfaced as suggestion cards. Each slice is
   * toggled independently. A missing key falls back to the slice's built-in default in the UI.
   */
  cleanupSlices: Record<CleanupSliceId, boolean>;
  /** Cold-storage age threshold (years) — older mail without value markers is a candidate. */
  cleanupColdYears: number;
  /** Large-message size threshold (MB). */
  cleanupLargeMinMb: number;
  /**
   * Hrefs of address books collapsed (hidden) in the Contacts manager. A view-only
   * preference — it never affects which books feed composer autocomplete (that's the
   * server-side "active" set); it only hides a book's section in the manager list.
   */
  hiddenContactBooks: string[];
  /**
   * Card UIDs starred as favourites, pinned to the top of the contacts list. Kept in
   * prefs rather than as a vCard CATEGORY so starring stays a maily-local view choice —
   * it never rewrites the card on Radicale or leaks into other CardDAV clients.
   */
  favoriteContacts: string[];
  /**
   * Lowercased addresses whose "add as contact" prompt the user dismissed. The reader
   * offers the prompt once per unknown sender; dismissing it is permanent and synced, so
   * the offer can never accumulate into a backlog of senders to triage.
   */
  dismissedContactPrompts: string[];
}

const DEFAULTS: Prefs = {
  blockRemoteImages: false,
  unreadAtTop: true,
  conversationView: true,
  newestMessageFirst: true,
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
  cleanupSlices: {
    large: true,
    'cold-storage': true,
    newsletters: true,
  },
  cleanupColdYears: 2,
  cleanupLargeMinMb: 10,
  hiddenContactBooks: [],
  favoriteContacts: [],
  dismissedContactPrompts: [],
};

/** Prefs that suit a screen rather than the user: never pushed, and a server copy is ignored. */
const DEVICE_ONLY: ReadonlySet<keyof Prefs> = new Set<keyof Prefs>([
  'readingPaneMinWidth',
  'clientCacheDays',
]);

const PREF_KEYS = Object.keys(DEFAULTS) as (keyof Prefs)[];
const SYNCED_KEYS = PREF_KEYS.filter((k) => !DEVICE_ONLY.has(k));

const KEY = 'maily.prefs';
/** Synced keys edited on this device that the server hasn't confirmed, kept across a reload. */
const UNSYNCED_KEY = 'maily.prefs.unsynced';

function load(): Prefs {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    const prefs: Record<string, unknown> = { ...DEFAULTS };
    // Known keys only, so a pref that has since moved or been removed drops out of the cache.
    for (const k of PREF_KEYS) if (Object.hasOwn(stored, k)) prefs[k] = stored[k];
    return prefs as unknown as Prefs;
  } catch {
    return DEFAULTS;
  }
}

function loadUnsynced(): Set<keyof Prefs> {
  try {
    const stored = JSON.parse(localStorage.getItem(UNSYNCED_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(stored) ? SYNCED_KEYS.filter((k) => stored.includes(k)) : []);
  } catch {
    return new Set();
  }
}

let current = load();
const unsynced = loadUnsynced();
// Pushes the server has accepted. A hydration that started before one landed may carry the
// value that push replaced, so it's discarded; the push's `settings:changed` signal re-hydrates.
let pushesLanded = 0;
const listeners = new Set<() => void>();

function saveLocal(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
    localStorage.setItem(UNSYNCED_KEY, JSON.stringify([...unsynced]));
  } catch {
    // Best-effort: storage may be full or disabled — the offline cache just won't persist.
  }
}

function notify(): void {
  for (const l of listeners) l();
}

// Debounced so rapid edits (e.g. typing a signature) coalesce into one request.
let pushTimer: ReturnType<typeof setTimeout> | undefined;
function schedulePush(): void {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(push, 600);
}

/** Send the unsynced keys. A key edited again while the request is in flight stays unsynced. */
function push(): void {
  if (unsynced.size === 0) return;
  const patch: Record<string, unknown> = {};
  for (const k of unsynced) patch[k] = current[k];
  void api
    .patchSettings(patch)
    .then(() => {
      pushesLanded++;
      for (const k of Object.keys(patch) as (keyof Prefs)[]) {
        if (current[k] === patch[k]) unsynced.delete(k);
      }
      saveLocal();
    })
    .catch(() => {
      // Offline / unauthorized — the keys stay unsynced and go up with the next push.
    });
}

export function getPrefs(): Prefs {
  return current;
}

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  current = { ...current, [key]: value };
  const synced = !DEVICE_ONLY.has(key);
  if (synced) unsynced.add(key);
  saveLocal();
  notify();
  if (synced) schedulePush();
}

/**
 * Adopt the server's synced prefs (the cross-device source of truth), keeping this device's own
 * prefs and any local edit the server hasn't confirmed yet, which is pushed again. A server with
 * nothing stored is seeded from this device. Best-effort: offline/unauthorized keeps the cache.
 */
export async function hydratePrefs(): Promise<void> {
  const landed = pushesLanded;
  let server: Record<string, unknown>;
  try {
    server = await api.getSettings();
  } catch {
    return;
  }
  if (pushesLanded !== landed) return;

  if (Object.keys(server).length === 0) {
    for (const k of SYNCED_KEYS) unsynced.add(k);
    saveLocal();
    push();
    return;
  }

  const next: Record<string, unknown> = { ...current };
  let changed = false;
  for (const k of SYNCED_KEYS) {
    if (unsynced.has(k)) continue;
    const value = Object.hasOwn(server, k) ? server[k] : DEFAULTS[k];
    if (JSON.stringify(value) !== JSON.stringify(current[k])) {
      next[k] = value;
      changed = true;
    }
  }
  if (changed) {
    current = next as unknown as Prefs;
    saveLocal();
    notify();
  }
  if (unsynced.size > 0) schedulePush();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reactive read of the whole prefs object. */
export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, getPrefs, getPrefs);
}
