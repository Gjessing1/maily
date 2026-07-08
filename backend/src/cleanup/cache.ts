/**
 * Precomputed cleanup-analytics cache. The slice computes in slices.ts are full-table
 * aggregates (group-by-domain + FTS sub-selects), so running all of them on every
 * dashboard visit makes the Cleanup screen feel slow. This layer memoises each slice's
 * full {@link SliceData} (and the summary) keyed by slice + thresholds, and keeps the
 * cache *warm in advance*:
 *
 *  - **Invalidation** rides the in-process signal bus — any mail mutation (new / flags /
 *    deleted / archived) bumps the data version, so a hit is never stale relative to a
 *    signalled write.
 *  - **Re-warm, debounced**: after a quiet period following the last signal, the recently
 *    requested slice/threshold combos (seeded with the defaults) are recomputed in the
 *    background, so the next dashboard visit is served from memory.
 *  - **Periodic re-warm** catches writers that emit no signal (the archive sweep filling
 *    `source_bytes`, the source-bytes backfill).
 *
 * Reads stay correct without the warmer running (a miss just computes synchronously, as
 * the routes used to); the warmer only moves that cost off the request path. Execution
 * paths (drill-down message lists, sliceMessageIds) are deliberately NOT cached — they
 * must re-resolve fresh against the safety gate.
 */
import type { CleanupSummaryDto } from '@maily/shared';
import { onSignal } from '../events.js';
import { createLogger } from '../logger.js';
import {
  cleanupSummary,
  computeSliceData,
  type PreviewSlice,
  type SliceData,
  type SliceThresholds,
} from './slices.js';

const log = createLogger('cleanup-cache');

/** Quiet period after the last mail signal before the background re-warm kicks in. */
const WARM_DEBOUNCE_MS = 5_000;
/** Periodic full re-warm — catches DB writers that emit no signal (archive sweep). */
const REWARM_INTERVAL_MS = 10 * 60_000;
/** Cap on remembered warm targets (recently requested slice/threshold combos). */
const MAX_WARM_TARGETS = 24;

interface WarmTarget {
  slice: PreviewSlice;
  t: SliceThresholds;
}

const keyOf = (slice: PreviewSlice, t: SliceThresholds): string =>
  `${slice}|${t.years ?? ''}|${t.minMb ?? ''}`;

/** Monotonic data version; bumped on every mail mutation signal and periodic re-warm. */
let version = 0;
let wired = false;

const sliceCache = new Map<string, { version: number; data: SliceData }>();
let summaryCache: { version: number; data: CleanupSummaryDto } | null = null;

/**
 * What a re-warm recomputes: the default-threshold slices (always useful — they match the
 * backend defaults, i.e. the Balanced preset) plus whatever combos were requested recently
 * (other presets' thresholds). Map insertion order doubles as LRU order.
 */
const warmTargets = new Map<string, WarmTarget>(
  (
    [
      { slice: 'storage', t: {} },
      { slice: 'newsletters', t: {} },
      { slice: 'cold-storage', t: {} },
      { slice: 'large', t: {} },
    ] satisfies WarmTarget[]
  ).map((w) => [keyOf(w.slice, w.t), w]),
);

let warmTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleWarm(delayMs: number): void {
  clearTimeout(warmTimer);
  warmTimer = setTimeout(() => void warm(), delayMs);
  warmTimer.unref?.();
}

/** Subscribe (once) to the signal bus so any mail mutation invalidates + re-warms. */
function ensureWired(): void {
  if (wired) return;
  wired = true;
  onSignal((signal) => {
    if (signal.type === 'sync:progress') return; // progress ticks don't change slice data
    version += 1;
    scheduleWarm(WARM_DEBOUNCE_MS);
  });
}

let warming = false;

/**
 * Recompute the summary and every stale warm target in the background, yielding to the
 * event loop between slices (better-sqlite3 is synchronous). Coalesces concurrent calls.
 */
async function warm(): Promise<void> {
  if (warming) {
    scheduleWarm(WARM_DEBOUNCE_MS); // a warm is running — try again after it finishes
    return;
  }
  warming = true;
  const started = Date.now();
  let computed = 0;
  try {
    if (summaryCache?.version !== version) {
      const v = version;
      summaryCache = { version: v, data: cleanupSummary() };
      computed += 1;
    }
    for (const [key, target] of warmTargets) {
      if (sliceCache.get(key)?.version === version) continue;
      const v = version;
      sliceCache.set(key, { version: v, data: computeSliceData(target.slice, target.t) });
      computed += 1;
      await new Promise((resolve) => setImmediate(resolve));
    }
  } catch (err) {
    log.warn(`cleanup cache warm failed: ${(err as Error).message}`);
  } finally {
    warming = false;
  }
  if (computed > 0)
    log.info(`warmed ${computed} cleanup aggregate(s) in ${Date.now() - started}ms`);
}

/** Remember a requested combo for future re-warms, evicting the least recently used. */
function rememberTarget(key: string, target: WarmTarget): void {
  warmTargets.delete(key); // re-insert to refresh recency
  warmTargets.set(key, target);
  while (warmTargets.size > MAX_WARM_TARGETS) {
    const oldest = warmTargets.keys().next().value as string;
    warmTargets.delete(oldest);
  }
}

/** Cached full slice data — a hit is served from memory, a miss computes synchronously. */
export function cachedSliceData(slice: PreviewSlice, t: SliceThresholds = {}): SliceData {
  ensureWired();
  const key = keyOf(slice, t);
  rememberTarget(key, { slice, t });
  const hit = sliceCache.get(key);
  if (hit && hit.version === version) return hit.data;
  const v = version;
  const data = computeSliceData(slice, t);
  sliceCache.set(key, { version: v, data });
  return data;
}

/**
 * Force-invalidate the cache from a writer that emits no mail signal (the preserve-from-cleanup
 * toggle): bump the version so the next read recomputes, and schedule a debounced re-warm so the
 * dashboard is hot again. Used by the cleanup "keep" route, whose write changes slice membership
 * without going through the normal new/flags/deleted/archived signal path.
 */
export function bumpCleanupCache(): void {
  ensureWired();
  version += 1;
  scheduleWarm(WARM_DEBOUNCE_MS);
}

/** Cached dashboard summary (same version discipline as the slices). */
export function cachedSummary(): CleanupSummaryDto {
  ensureWired();
  if (summaryCache && summaryCache.version === version) return summaryCache.data;
  const v = version;
  const data = cleanupSummary();
  summaryCache = { version: v, data };
  return data;
}

/**
 * Boot hook: wire invalidation, warm the cache shortly after start (so the first dashboard
 * visit is already hot), and re-warm periodically to absorb unsignalled writes.
 */
export function startCleanupCache(): void {
  ensureWired();
  scheduleWarm(3_000);
  const timer = setInterval(() => {
    version += 1; // distrust the cache on the periodic tick — unsignalled writes may exist
    void warm();
  }, REWARM_INTERVAL_MS);
  timer.unref?.();
}
