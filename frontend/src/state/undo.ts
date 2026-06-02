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
  id: string;
  label: string;
  /** Snapshots kept so undo can re-insert the optimistically-removed rows. */
  message?: CachedMessage;
  body?: CachedBody;
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

/** Commit the pending delete to the server, then clear undo state. */
function commit(): void {
  if (!pending) return;
  const { id } = pending;
  clearTimer();
  pending = null;
  // Server move to Trash is out-of-band; the next folder resync is authoritative.
  api.deleteMessage(id).catch(() => undefined);
  notify();
}

/**
 * Stage a delete: snapshot + optimistically remove the cached rows, then arm the
 * undo window. A second delete while one is pending commits the first immediately.
 */
export async function requestDelete(id: string, label = 'Message deleted'): Promise<void> {
  commit();
  const message = await cache.messages.get(id);
  const body = await cache.bodies.get(id);
  await removeCachedMessage(id);
  pending = { id, label, message, body };
  timer = setTimeout(commit, WINDOW_MS);
  notify();
}

/** Cancel a pending delete and restore the cached rows. No server call is made. */
export async function undoDelete(): Promise<void> {
  if (!pending) return;
  clearTimer();
  const { message, body } = pending;
  pending = null;
  if (message) await cache.messages.put(message);
  if (body) await cache.bodies.put(body);
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
