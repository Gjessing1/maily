/**
 * Session-lived review state for the Cleanup drill-down flow. Two small in-memory stores
 * that make the sender-list ⇄ message-drill loop fluid (nothing here is persisted —
 * a reload starts a fresh review, deliberately):
 *
 *  - **Drill selection state** (which rows are un/checked, the typed filter) — opening a
 *    message in the reader (or backing out to the sender list) unmounts the drill screen,
 *    so without this an in-progress review is lost the moment you inspect one message.
 *    Keyed by the exact drill (slice + sender + thresholds).
 *  - **Sender-browser UI state** (open/closed, search, sort, thresholds) — backing out of
 *    a drill returns to the Cleanup dashboard, and restoring this state is what makes
 *    "back" land on the *open* "Review by sender" list you left, not a collapsed card.
 *
 * The marked-count helper turns a saved drill selection into the "19/21 marked" badge the
 * sender rows show, so you can hop between senders and see review progress at a glance.
 */

/** A drill-down's in-progress selection + filter. */
export interface DrillState {
  q: string;
  /** 'all' = everything selected minus `excluded`; 'manual' = only `included`. */
  mode: 'all' | 'manual';
  excluded: string[];
  included: string[];
  /** Summed bytes of the `excluded` rows — lets the sender list price a partial review. */
  excludedBytes: number;
  /** Summed bytes of the `included` rows. */
  includedBytes: number;
}

const drillStore = new Map<string, DrillState>();

/** Canonical key for one drill: slice + sender + the thresholds it was opened with. */
export function drillStateKey(p: {
  slice: string;
  domain?: string;
  years?: number;
  minMb?: number;
}): string {
  return [p.slice, p.domain ?? '', p.years ?? '', p.minMb ?? ''].join('|');
}

export function getDrillState(key: string): DrillState | undefined {
  return drillStore.get(key);
}

export function setDrillState(key: string, state: DrillState): void {
  drillStore.set(key, state);
}

export function deleteDrillState(key: string): void {
  drillStore.delete(key);
}

/**
 * How many of a sender's `total` messages the saved review has marked for trashing, or
 * null when that sender was never drilled into (no badge). 'all' mode marks everything
 * except the unchecked ids; 'manual' marks exactly the picked ones.
 */
export function drillMarkedCount(key: string, total: number): number | null {
  const s = drillStore.get(key);
  if (!s) return null;
  return s.mode === 'all' ? Math.max(0, total - s.excluded.length) : s.included.length;
}

/**
 * Estimated bytes the saved review would trash, given the sender's `totalBytes`, or null when
 * that sender was never drilled into. The byte sums are recorded by the drill screen from its
 * loaded rows (an id can only be un/checked once loaded, so the sums are exact).
 */
export function drillMarkedBytes(key: string, totalBytes: number): number | null {
  const s = drillStore.get(key);
  if (!s) return null;
  return s.mode === 'all' ? Math.max(0, totalBytes - s.excludedBytes) : s.includedBytes;
}

/** The sender browser's UI state — restored so "back" lands on the open list you left. */
export interface BrowserState {
  open: boolean;
  q: string;
  sort: 'bytes' | 'count' | 'name';
  minMsgs: string;
  minSizeMb: string;
}

const browserStore = new Map<string, BrowserState>();

export function getBrowserState(key: string): BrowserState | undefined {
  return browserStore.get(key);
}

export function setBrowserState(key: string, state: BrowserState): void {
  browserStore.set(key, state);
}

/** Drop all saved review state — tests only (module stores outlive a component tree). */
export function resetCleanupReviewState(): void {
  drillStore.clear();
  browserStore.clear();
}
