/**
 * On-demand cleanup-analytics cache. Slice computation is expensive, so repeated dashboard
 * reads memoise the full unpaginated aggregates. Cache validity comes from the durable,
 * trigger-maintained cleanup data version rather than from process-local signals; worker-thread
 * and direct database writes therefore cannot leave a stale result behind.
 *
 * There is intentionally no boot, signal, or periodic warmer. The occasional Cleanup visit pays
 * for a stale aggregate when it asks for one, instead of taxing the main event loop every ten
 * minutes. Drill-down and execution reads remain uncached and always re-run the safety gate.
 */
import type { CleanupSummaryDto } from '@maily/shared';
import { dataVersion } from '../db/dataVersion.js';
import {
  cleanupSummary,
  computeSliceData,
  type PreviewSlice,
  type SliceData,
  type SliceThresholds,
} from './slices.js';

const keyOf = (slice: PreviewSlice, t: SliceThresholds): string =>
  `${slice}|${t.years ?? ''}|${t.minMb ?? ''}`;

const MAX_SLICE_ENTRIES = 24;
const sliceCache = new Map<string, { version: number; data: SliceData }>();
let summaryCache: { version: number; data: CleanupSummaryDto } | null = null;

function storeSlice(key: string, entry: { version: number; data: SliceData }): void {
  sliceCache.delete(key);
  sliceCache.set(key, entry);
  while (sliceCache.size > MAX_SLICE_ENTRIES) {
    const oldest = sliceCache.keys().next().value as string;
    sliceCache.delete(oldest);
  }
}

/** Cached full slice data — a hit is a memory read; a stale entry computes on demand. */
export function cachedSliceData(slice: PreviewSlice, t: SliceThresholds = {}): SliceData {
  const version = dataVersion('cleanup');
  const key = keyOf(slice, t);
  const hit = sliceCache.get(key);
  if (hit?.version === version) {
    storeSlice(key, hit); // refresh LRU recency
    return hit.data;
  }

  // Keep the version captured before the multi-statement compute. If another connection writes
  // while it runs, the stored entry remains deliberately stale and the next read recomputes.
  const data = computeSliceData(slice, t);
  storeSlice(key, { version, data });
  return data;
}

/** Cached dashboard summary, following the same durable-version discipline as slices. */
export function cachedSummary(): CleanupSummaryDto {
  const version = dataVersion('cleanup');
  if (summaryCache?.version === version) return summaryCache.data;
  const data = cleanupSummary();
  summaryCache = { version, data };
  return data;
}
