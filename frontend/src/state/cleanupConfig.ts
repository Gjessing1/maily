/**
 * Cleanup configuration (ROADMAP Phase 6b). Replaces the old fixed strict/balanced/aggressive
 * presets with a per-slice model: each delete-eligible slice is toggled on/off independently
 * and carries its own tunable threshold (cold-storage years / large-message MB / unread months),
 * plus user-extendable keyword lists. The settings live in synced prefs; the backend honours the
 * thresholds + custom keywords on the preview, drill-down and execute paths, so this stays a
 * client-side profile.
 *
 * Lives in state/ (not the Cleanup route) so the dashboard prefetcher can resolve the active
 * thresholds without importing the whole route module.
 */
import type { CleanupSliceId, Prefs } from './prefs';

/** Delete-eligible slice ids (must match the backend's DELETE_SLICES set). */
export type ActionSlice = CleanupSliceId;

/** Per-slice tunable thresholds, threaded through preview, drill-down and execute. */
export interface SliceParams {
  /** Cold-storage age threshold (years). */
  years?: number;
  /** Large-message size threshold (MB). */
  minMb?: number;
  /** Unread-and-old age threshold (months). */
  months?: number;
}

/** Slice render order on the dashboard (the storage audit is rendered separately, first). */
export const SLICE_ORDER: ActionSlice[] = [
  'large',
  'never-replied',
  'newsletters',
  'unread',
  'cold-storage',
];

/** Built-in on/off state for each slice — the fallback when a stored pref lacks the key. */
const DEFAULT_SLICES_ENABLED: Record<ActionSlice, boolean> = {
  large: true,
  'cold-storage': true,
  unread: true,
  newsletters: true,
  'never-replied': true,
};

/** Stored slice toggles merged over the built-in defaults (new slices keep their default). */
export function enabledSlices(prefs: Prefs): Record<ActionSlice, boolean> {
  return { ...DEFAULT_SLICES_ENABLED, ...(prefs.cleanupSlices ?? {}) };
}

/** The backend thresholds the active config asks for (what keys the dashboard fetch uses). */
export function cleanupThresholds(prefs: Prefs): Required<SliceParams> {
  return {
    years: prefs.cleanupColdYears,
    minMb: prefs.cleanupLargeMinMb,
    months: prefs.cleanupUnreadMonths,
  };
}
