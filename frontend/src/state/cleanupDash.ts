/**
 * Cleanup Dashboard data store — stale-while-revalidate. The dashboard payload (one
 * bundled `/api/cleanup/dashboard` response) is cached in memory and mirrored to
 * `sessionStorage`, so opening the Cleanup screen renders the last-known figures
 * instantly while a background refresh swaps in fresh ones. The network fetch begins only
 * when the user opens Cleanup, so its expensive server aggregates never become background work.
 *
 * Analytics only — executions always go straight to the API; this cache never gates a
 * destructive action (the server re-validates every execute anyway).
 */
import type { CleanupDashboardDto } from '@maily/shared';
import { api } from '../api/client';
import type { SliceParams } from './cleanupConfig';

const KEY = 'maily.cleanupDash';

/** Cache key for one thresholds combo (different presets cache separately). */
export function dashKey(t: SliceParams): string {
  return `${t.years ?? ''}|${t.minMb ?? ''}`;
}

type Stored = Record<string, CleanupDashboardDto>;

function load(): Stored {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Stored) : {};
  } catch {
    return {};
  }
}

let cache: Stored = load();

function save(): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // Best-effort mirror — losing it only costs the instant first paint after a reload.
  }
}

/** Last-known dashboard for these thresholds, or null when never fetched this session. */
export function cachedDashboard(t: SliceParams): CleanupDashboardDto | null {
  return cache[dashKey(t)] ?? null;
}

/** Fetch fresh dashboard data and update the cache (the revalidate half of SWR). */
export async function loadDashboard(t: SliceParams): Promise<CleanupDashboardDto> {
  const data = await api.cleanup.dashboard(t);
  cache = { ...cache, [dashKey(t)]: data };
  save();
  return data;
}
