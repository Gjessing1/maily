/**
 * Undo window for deletes (backlog: "undo window after delete / swipe-to-delete").
 * A delete is staged here, not sent immediately: the row is removed from the local
 * cache optimistically and a snackbar offers a few seconds to undo before the
 * server move to Trash is committed. Module-level state (not React state) so the
 * pending delete survives route changes — the Reader navigates away on delete.
 */
import { useSyncExternalStore } from 'react';
import { api } from '../api/client';
import { cache, removeCachedMessage, type CachedBody, type CachedMessage } from '../db/cache';

/** How long the undo snackbar stays before the delete commits server-side. */
const WINDOW_MS = 5000;

interface Pending {
  /** Every message id in this batch (one for a swipe/context delete, many for bulk). */
  ids: string[];
  label: string;
  /** Snapshots kept so undo can re-insert the optimistically-removed rows. */
  messages: CachedMessage[];
  bodies: CachedBody[];
}

let pending: Pending | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function clearTimer(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/** Commit the pending delete(s) to the server, then clear undo state. */
function commit(): void {
  if (!pending) return;
  const { ids } = pending;
  clearTimer();
  pending = null;
  // Server move to Trash is out-of-band; the next folder resync is authoritative.
  for (const id of ids) api.deleteMessage(id).catch(() => undefined);
  notify();
}

/**
 * Stage a single delete: snapshot + optimistically remove the cached rows, then arm
 * the undo window. A second delete while one is pending commits the first immediately.
 */
export async function requestDelete(id: string, label = 'Message deleted'): Promise<void> {
  return requestDeleteMany([id], label);
}

/**
 * Stage a batch delete (multi-select). Same undo window as a single delete, so a
 * bulk delete is just as recoverable as a swipe; the snackbar labels the count.
 */
export async function requestDeleteMany(ids: string[], label?: string): Promise<void> {
  if (ids.length === 0) return;
  commit();
  const messages: CachedMessage[] = [];
  const bodies: CachedBody[] = [];
  for (const id of ids) {
    const message = await cache.messages.get(id);
    const body = await cache.bodies.get(id);
    if (message) messages.push(message);
    if (body) bodies.push(body);
    await removeCachedMessage(id);
  }
  pending = {
    ids,
    label: label ?? (ids.length === 1 ? 'Message deleted' : `${ids.length} messages deleted`),
    messages,
    bodies,
  };
  timer = setTimeout(commit, WINDOW_MS);
  notify();
}

/** Cancel the pending delete(s) and restore the cached rows. No server call is made. */
export async function undoDelete(): Promise<void> {
  if (!pending) return;
  clearTimer();
  const { messages, bodies } = pending;
  pending = null;
  for (const m of messages) await cache.messages.put(m);
  for (const b of bodies) await cache.bodies.put(b);
  notify();
}

function snapshot(): Pending | null {
  return pending;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reactive read of the current pending delete (drives the snackbar). */
export function usePendingDelete(): Pending | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
