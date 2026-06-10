/**
 * Cleanup aggressiveness presets (ROADMAP Phase 6b.2). A preset is a profile over the
 * deterministic slices: the thresholds (`coldYears` / `largeMinMb` / `unreadMonths`,
 * smaller or shorter = more aggressive) plus `slices` — which angles it surfaces at all.
 * 'strict' keeps only the hardest signals (age, raw size) and withholds the behavioural
 * heuristics (never-replied / never-opened / newsletters). The backend honours the
 * thresholds on the preview, drill-down and execute paths, so the preset is purely a
 * client-side profile.
 *
 * Lives in state/ (not the Cleanup route) so the dashboard prefetcher can resolve the
 * active preset's thresholds without importing the whole route module.
 */
import type { CleanupPreset } from './prefs';

/** Delete-eligible slice ids (must match the backend's DELETE_SLICES set). */
export type ActionSlice = 'never-replied' | 'cold-storage' | 'large' | 'unread' | 'newsletters';

/** Per-slice tunable thresholds, threaded through preview, drill-down and execute. */
export interface SliceParams {
  /** Cold-storage age threshold (years). */
  years?: number;
  /** Large-message size threshold (MB). */
  minMb?: number;
  /** Unread-and-old age threshold (months). */
  months?: number;
}

export const PRESETS: Record<
  CleanupPreset,
  {
    label: string;
    coldYears: number;
    largeMinMb: number;
    unreadMonths: number;
    slices: ActionSlice[];
  }
> = {
  strict: {
    label: 'Strict',
    coldYears: 5,
    largeMinMb: 25,
    unreadMonths: 24,
    slices: ['cold-storage', 'large'],
  },
  balanced: {
    label: 'Balanced',
    coldYears: 2,
    largeMinMb: 10,
    unreadMonths: 12,
    slices: ['never-replied', 'cold-storage', 'large', 'unread', 'newsletters'],
  },
  aggressive: {
    label: 'Aggressive',
    coldYears: 1,
    largeMinMb: 5,
    unreadMonths: 6,
    slices: ['never-replied', 'cold-storage', 'large', 'unread', 'newsletters'],
  },
};

export const PRESET_ORDER: CleanupPreset[] = ['strict', 'balanced', 'aggressive'];

/** The backend thresholds the given preset asks for (what keys the dashboard fetch uses). */
export function presetThresholds(preset: CleanupPreset): Required<SliceParams> {
  const p = PRESETS[preset] ?? PRESETS.balanced;
  return { years: p.coldYears, minMb: p.largeMinMb, months: p.unreadMonths };
}
