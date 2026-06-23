/**
 * Undo window for deferred actions — delete, archive, and send. The window is now **server
 * owned**: staging an action enqueues it in the backend outbox (which returns the `dueAt` when
 * it will actually commit) and optimistically hides the rows locally. This snackbar only mirrors
 * that window visually — the backend commits at `dueAt` whether or not the PWA stays open, so a
 * backgrounded/closed app can no longer drop the action. Undo cancels the outbox row server-side
 * (and, for delete/archive, the backend emits `mail:restored` so every client un-hides the row).
 *
 * Module-level state (not React state) so the pending action survives route changes — the Reader
 * navigates away on delete/archive.
 *
 * Hidden-id registry: cache-backed lists (the inbox) re-hide rows via their liveQuery, but Search
 * holds an independent result array with no such reactivity. `useHiddenIds()` exposes the ids
 * currently staged-away or committed-away so that list can filter them out and react to undo.
 */
import { useSyncExternalStore } from 'react';
import { api } from '../api/client';
import { cache, removeCachedMessage, type CachedBody, type CachedMessage } from '../db/cache';

/** Fallback window if the server didn't return a dueAt (kept in sync with the backend default). */
const FALLBACK_WINDOW_MS = 5000;
/** How long a transient error notice lingers. */
const NOTICE_MS = 4000;

type ActionKind = 'delete' | 'archive' | 'send';

export interface PendingAction {
  kind: ActionKind;
  /** Every message id in this batch (one for a swipe/context action, many for bulk). */
  ids: string[];
  label: string;
  /** Snapshots kept so undo can re-insert the optimistically-removed rows. */
  messages: CachedMessage[];
  bodies: CachedBody[];
  /** The outbox row ids backing this action — Undo cancels these server-side. */
  outboxIds: string[];
}

let pending: PendingAction | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Transient error notice (failed enqueue / failed flag change / too-late undo). */
let notice: string | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

/** Ids committed-away this session (window elapsed) — kept so Search stays them hidden. */
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
  if (kind === 'send') return 'Message sent';
  const noun = count === 1 ? 'Message' : `${count} messages`;
  return `${noun} ${kind === 'archive' ? 'archived' : 'deleted'}`;
}

/**
 * Finalise the pending action: the server already owns the commit at its `dueAt`, so window
 * expiry just keeps the rows hidden (record them in `committed`) and drops the snackbar.
 */
function commit(): void {
  if (!pending) return;
  clearTimer();
  for (const id of pending.ids) committed.add(id);
  pending = null;
  notify();
}

/**
 * Stage a batch delete/archive: snapshot + optimistically remove the rows, enqueue the deferred
 * MOVE server-side (returns the outbox id + dueAt), then arm the snackbar to that dueAt. Rows the
 * server couldn't queue are restored with a notice.
 */
async function stage(kind: 'delete' | 'archive', ids: string[], label?: string): Promise<void> {
  if (ids.length === 0) return;
  commit(); // a second action while one is pending finalises the first immediately

  const snapMessages = new Map<string, CachedMessage>();
  const snapBodies = new Map<string, CachedBody>();
  for (const id of ids) {
    const message = await cache.messages.get(id);
    const body = await cache.bodies.get(id);
    if (message) snapMessages.set(id, message);
    if (body) snapBodies.set(id, body);
    await removeCachedMessage(id);
  }

  const call = kind === 'archive' ? api.archiveMessage : api.deleteMessage;
  const outboxIds: string[] = [];
  const okIds: string[] = [];
  const failed: string[] = [];
  let dueAt = Date.now() + FALLBACK_WINDOW_MS;
  await Promise.all(
    ids.map(async (id) => {
      try {
        const res = await call(id);
        if (res.outboxId) outboxIds.push(res.outboxId);
        if (typeof res.dueAt === 'number') dueAt = res.dueAt;
        okIds.push(id);
      } catch {
        failed.push(id);
      }
    }),
  );

  if (failed.length > 0) {
    // Couldn't queue the move server-side — restore those rows so they don't silently vanish.
    for (const id of failed) {
      const m = snapMessages.get(id);
      const b = snapBodies.get(id);
      if (m) await cache.messages.put(m);
      if (b) await cache.bodies.put(b);
    }
    showNotice(kind === 'archive' ? 'Couldn’t archive — restored' : 'Couldn’t delete — restored');
  }
  if (okIds.length === 0) {
    notify();
    return;
  }

  pending = {
    kind,
    ids: okIds,
    label: label ?? defaultLabel(kind, okIds.length),
    messages: okIds.map((id) => snapMessages.get(id)).filter((m): m is CachedMessage => !!m),
    bodies: okIds.map((id) => snapBodies.get(id)).filter((b): b is CachedBody => !!b),
    outboxIds,
  };
  timer = setTimeout(() => commit(), Math.max(0, dueAt - Date.now()));
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

/**
 * Stage a just-queued send so the snackbar offers "Undo send" until the server's `dueAt`.
 * The send is already owned by the backend outbox; this only mirrors the window visually.
 */
export async function stageSend(outboxId: string, dueAt: number, label?: string): Promise<void> {
  commit(); // flush any pending action first
  pending = {
    kind: 'send',
    ids: [],
    label: label ?? defaultLabel('send', 1),
    messages: [],
    bodies: [],
    outboxIds: [outboxId],
  };
  timer = setTimeout(() => commit(), Math.max(0, dueAt - Date.now()));
  notify();
}

/**
 * Cancel the pending action: cancel each backing outbox row server-side, then restore the
 * optimistically-removed rows. During the visible window the action's `dueAt` is still in the
 * future, so the runner hasn't claimed it and the cancel reliably wins.
 */
export async function undoAction(): Promise<void> {
  if (!pending) return;
  clearTimer();
  const { messages, bodies, outboxIds, kind } = pending;
  pending = null;

  let tooLate = false;
  await Promise.all(
    outboxIds.map((id) =>
      api.cancelOutbox(id).catch(() => {
        tooLate = true;
      }),
    ),
  );

  // Restore snapshots (delete/archive). A send has no local snapshot — the backend saves the
  // canceled send back to \Drafts; if the cancel was too late it already went out.
  for (const m of messages) await cache.messages.put(m);
  for (const b of bodies) await cache.bodies.put(b);
  if (kind === 'send') {
    showNotice(tooLate ? 'Already sent — too late to undo' : 'Send canceled — saved to Drafts');
  }
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
