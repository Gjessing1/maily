/**
 * Undo window for destructive list actions — delete *and* archive (backlog: "undo
 * window after delete / swipe-to-delete", extended to archive for parity). The action
 * is staged here, not sent immediately: the rows are removed from the local cache
 * optimistically and a snackbar offers a few seconds to undo before the server move
 * commits. Module-level state (not React state) so the pending action survives route
 * changes — the Reader navigates away on delete/archive.
 *
 * Two extras layered on top of the basic window:
 *  - **Failure handling.** If the server rejects the committed move, the snapshotted
 *    rows are restored to the cache (so they don't silently vanish until the next
 *    resync) and a transient error notice is surfaced.
 *  - **Hidden-id registry.** Cache-backed lists (the inbox) re-hide rows automatically
 *    via their liveQuery, but Search holds an independent result array with no such
 *    reactivity. `useHiddenIds()` exposes the ids that are currently staged-away or
 *    permanently committed-away so that list can filter them out and react to undo.
 */
import { useSyncExternalStore } from 'react';
import { api } from '../api/client';
import { cache, removeCachedMessage, type CachedBody, type CachedMessage } from '../db/cache';

/** How long the undo snackbar stays before the action commits server-side. */
const WINDOW_MS = 5000;
/** How long a transient error notice lingers. */
const NOTICE_MS = 4000;

type ActionKind = 'delete' | 'archive';

export interface PendingAction {
  kind: ActionKind;
  /** Every message id in this batch (one for a swipe/context action, many for bulk). */
  ids: string[];
  label: string;
  /** Snapshots kept so undo (or a failed commit) can re-insert the removed rows. */
  messages: CachedMessage[];
  bodies: CachedBody[];
}

let pending: PendingAction | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Transient error notice (failed commit / failed flag change). */
let notice: string | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

/** Ids committed-away this session (permanent) — kept so Search can stay them hidden. */
const committed = new Set<string>();
/** Cached union (committed ∪ pending) handed to `useHiddenIds`; rebuilt only on change. */
let hidden = new Set<string>();

const listeners = new Set<() => void>();

function rebuildHidden(): void {
  const next = new Set(committed);
  if (pending) for (const id of pending.ids) next.add(id);
  hidden = next;
}

function notify(): void {
  rebuildHidden();
  for (const l of listeners) l();
}

function clearTimer(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/** Show a short-lived error notice in the snackbar (auto-dismisses). */
export function showNotice(message: string): void {
  notice = message;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice = null;
    noticeTimer = null;
    notify();
  }, NOTICE_MS);
  notify();
}

function defaultLabel(kind: ActionKind, count: number): string {
  const noun = count === 1 ? 'Message' : `${count} messages`;
  return `${noun} ${kind === 'archive' ? 'archived' : 'deleted'}`;
}

/** Commit the pending action to the server, then clear undo state. */
async function commit(): Promise<void> {
  if (!pending) return;
  const { kind, ids, messages, bodies } = pending;
  clearTimer();
  // Mark these as permanently gone before the async calls so a list that re-reads
  // mid-commit doesn't flash the rows back; failures below re-add them.
  for (const id of ids) committed.add(id);
  pending = null;
  notify();

  const call = kind === 'archive' ? api.archiveMessage : api.deleteMessage;
  const failed: string[] = [];
  await Promise.all(
    ids.map((id) =>
      call(id).catch(() => {
        failed.push(id);
      }),
    ),
  );

  if (failed.length > 0) {
    // The server rejected the move: restore the snapshotted rows so they don't vanish
    // until the next resync, and tell the user it didn't stick.
    const failedSet = new Set(failed);
    for (const id of failed) committed.delete(id);
    for (const m of messages) if (failedSet.has(m.id)) await cache.messages.put(m);
    for (const b of bodies) if (failedSet.has(b.id)) await cache.bodies.put(b);
    showNotice(kind === 'archive' ? 'Couldn’t archive — restored' : 'Couldn’t delete — restored');
  }
}

/** Stage a batch action: snapshot + optimistically remove the rows, then arm the window. */
async function stage(kind: ActionKind, ids: string[], label?: string): Promise<void> {
  if (ids.length === 0) return;
  await commit(); // a second action while one is pending commits the first immediately
  const messages: CachedMessage[] = [];
  const bodies: CachedBody[] = [];
  for (const id of ids) {
    const message = await cache.messages.get(id);
    const body = await cache.bodies.get(id);
    if (message) messages.push(message);
    if (body) bodies.push(body);
    await removeCachedMessage(id);
  }
  pending = { kind, ids, label: label ?? defaultLabel(kind, ids.length), messages, bodies };
  timer = setTimeout(() => void commit(), WINDOW_MS);
  notify();
}

/** Stage a single delete (soft-delete → Trash). */
export async function requestDelete(id: string, label?: string): Promise<void> {
  return stage('delete', [id], label);
}
/** Stage a batch delete (multi-select). Same undo window as a single delete. */
export async function requestDeleteMany(ids: string[], label?: string): Promise<void> {
  return stage('delete', ids, label);
}
/** Stage a single archive (move out of the inbox). */
export async function requestArchive(id: string, label?: string): Promise<void> {
  return stage('archive', [id], label);
}
/** Stage a batch archive (multi-select). */
export async function requestArchiveMany(ids: string[], label?: string): Promise<void> {
  return stage('archive', ids, label);
}

/** Cancel the pending action and restore the cached rows. No server call is made. */
export async function undoAction(): Promise<void> {
  if (!pending) return;
  clearTimer();
  const { messages, bodies } = pending;
  pending = null;
  for (const m of messages) await cache.messages.put(m);
  for (const b of bodies) await cache.bodies.put(b);
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reactive read of the current pending action (drives the snackbar). */
export function usePendingAction(): PendingAction | null {
  return useSyncExternalStore(
    subscribe,
    () => pending,
    () => pending,
  );
}

/** Reactive read of the transient error notice (drives the snackbar). */
export function useNotice(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => notice,
    () => notice,
  );
}

/**
 * Reactive set of ids hidden by a pending or committed action — for lists that aren't
 * cache-backed (Search) so they can filter rows out and re-show them on undo.
 */
export function useHiddenIds(): Set<string> {
  return useSyncExternalStore(
    subscribe,
    () => hidden,
    () => hidden,
  );
}
