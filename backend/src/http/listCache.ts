/**
 * Prepared first pages. The client is the premium customer here: the server has idle
 * time between mail events, so page one of every list view — and its unread companion
 * (`?unread=1`) — is precomputed and served from memory instead of being assembled per
 * request (the list query itself is indexed, but shaping DTOs adds a folder-ids +
 * attachments lookup per row). Same discipline as the cleanup-analytics cache:
 *
 *  - **Invalidation** rides the signal bus — any mail mutation bumps the data version,
 *    so a hit is never stale relative to a signalled write.
 *  - **Re-warm, debounced**: shortly after the last signal, recently served first pages
 *    (seeded at boot with the inbox views) are recomputed in the background, so the
 *    next visit is a pure memory read.
 *  - **Periodic distrust** catches writers that emit no signal (attachment downloads
 *    flipping `downloadedAt`, the archive sweep).
 *
 * Only cursor-less requests are cached — `before` pages are scroll traffic, unbounded
 * in key space and never the first paint. A miss computes synchronously exactly as the
 * routes always did; the cache only moves that work off the request path.
 */
import type { MessageDto } from '@maily/shared';
import { onSignal } from '../events.js';
import { createLogger } from '../logger.js';

const log = createLogger('list-cache');

/** Quiet period after the last mail signal before the background re-warm kicks in. */
const WARM_DEBOUNCE_MS = 2_000;
/** Periodic full re-warm — absorbs DB writers that emit no signal. */
const REWARM_INTERVAL_MS = 10 * 60_000;
/** Cap on remembered first-page targets (distinct view/limit/unread combos). */
const MAX_TARGETS = 32;

/** Monotonic data version; bumped on every mail mutation signal and periodic tick. */
let version = 0;
let wired = false;

const pages = new Map<string, { version: number; data: MessageDto[] }>();
/** LRU of recompute closures for the keys served recently (insertion order = recency). */
const targets = new Map<string, () => MessageDto[]>();

let warmTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleWarm(delayMs: number): void {
  clearTimeout(warmTimer);
  warmTimer = setTimeout(() => void warm(), delayMs);
  warmTimer.unref?.();
}

function ensureWired(): void {
  if (wired) return;
  wired = true;
  onSignal((signal) => {
    if (signal.type === 'sync:progress') return; // progress ticks don't change lists
    version += 1;
    scheduleWarm(WARM_DEBOUNCE_MS);
  });
}

let warming = false;

/**
 * Recompute every stale target in the background, yielding to the event loop between
 * pages (better-sqlite3 is synchronous). Coalesces concurrent calls.
 */
async function warm(): Promise<void> {
  if (warming) {
    scheduleWarm(WARM_DEBOUNCE_MS);
    return;
  }
  warming = true;
  const started = Date.now();
  let computed = 0;
  try {
    for (const [key, compute] of targets) {
      if (pages.get(key)?.version === version) continue;
      const v = version;
      pages.set(key, { version: v, data: compute() });
      computed += 1;
      await new Promise((resolve) => setImmediate(resolve));
    }
  } catch (err) {
    log.warn(`list cache warm failed: ${(err as Error).message}`);
  } finally {
    warming = false;
  }
  if (computed > 0) log.info(`warmed ${computed} first page(s) in ${Date.now() - started}ms`);
}

/** Remember a target for future re-warms, evicting the least recently served. */
function rememberTarget(key: string, compute: () => MessageDto[]): void {
  targets.delete(key); // re-insert to refresh recency
  targets.set(key, compute);
  while (targets.size > MAX_TARGETS) {
    const oldest = targets.keys().next().value as string;
    targets.delete(oldest);
    pages.delete(oldest);
  }
}

/**
 * Serve a first page through the cache: a hit is a memory read, a miss computes
 * synchronously (as the route always did) and becomes a warm target. Routes must
 * only call this for cursor-less requests — `before` pages bypass the cache.
 */
export function cachedFirstPage(key: string, compute: () => MessageDto[]): MessageDto[] {
  ensureWired();
  rememberTarget(key, compute);
  const hit = pages.get(key);
  if (hit && hit.version === version) return hit.data;
  const v = version;
  const data = compute();
  pages.set(key, { version: v, data });
  return data;
}

/** Register a first page to keep warm without waiting for a request (boot seeding). */
export function seedFirstPage(key: string, compute: () => MessageDto[]): void {
  ensureWired();
  rememberTarget(key, compute);
}

/**
 * Boot hook: wire invalidation, warm the seeded pages shortly after start (so the
 * first visit after a deploy is already hot), and periodically distrust the cache
 * to absorb unsignalled writes.
 */
export function startListCache(): void {
  ensureWired();
  scheduleWarm(3_000);
  const timer = setInterval(() => {
    version += 1;
    void warm();
  }, REWARM_INTERVAL_MS);
  timer.unref?.();
}
