/**
 * Pull-down-to-refresh for a scrollable element (mobile/APK).
 *
 * Touch-only by construction, so the desktop layout is untouched. The gesture is
 * claimed conservatively: the container must already be scrolled to the top, and the
 * drag must be predominantly vertical — otherwise the touch belongs to `MessageRow`'s
 * horizontal swipe actions, which see the same (bubbling, un-stopped) events.
 *
 * Nothing here calls `preventDefault`: React registers `touchmove` passively, and at
 * `scrollTop === 0` a downward drag has nothing left to scroll anyway.
 */
import { useEffect, useRef, useState, type TouchEvent } from 'react';

/** Drag distance (after resistance) that commits the refresh. */
const TRIGGER_PX = 64;
/** Cap on how far the indicator travels, so a long drag doesn't push the list off-screen. */
const MAX_PX = 96;
/** Where the indicator parks while the refresh runs. */
const RESTING_PX = 48;
/** Finger travel is halved, giving the pull the usual rubber-band feel. */
const RESISTANCE = 0.5;
/** Slop before a drag counts as directional, matching MessageRow's swipe threshold. */
const SLOP_PX = 8;
/** Keep the spinner up this long even if the refresh resolves instantly. */
const MIN_VISIBLE_MS = 500;

export interface PullToRefresh {
  /** Current indicator offset in px (drag distance, or the resting height while busy). */
  distance: number;
  /** 0…1 progress towards the trigger point — drives the indicator's reveal. */
  progress: number;
  /** True from the moment the gesture commits until the caller's work settles. */
  refreshing: boolean;
  /** True while a finger is driving `distance` — the indicator must not animate then. */
  dragging: boolean;
  handlers: {
    onTouchStart: (e: TouchEvent<HTMLElement>) => void;
    onTouchMove: (e: TouchEvent<HTMLElement>) => void;
    onTouchEnd: () => void;
  };
}

export function usePullToRefresh(
  onRefresh: () => void,
  { enabled = true, busy = false }: { enabled?: boolean; busy?: boolean } = {},
): PullToRefresh {
  const [distance, setDistance] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const claimed = useRef(false);
  const hideAfter = useRef(0);

  // Hold the indicator until the caller stops working *and* the minimum display time
  // has elapsed, so a warm cache doesn't flash a spinner for one frame.
  useEffect(() => {
    if (!refreshing || busy) return;
    const timer = setTimeout(
      () => setRefreshing(false),
      Math.max(0, hideAfter.current - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [refreshing, busy]);

  function onTouchStart(e: TouchEvent<HTMLElement>) {
    claimed.current = false;
    origin.current = null;
    if (!enabled || refreshing || e.touches.length !== 1) return;
    if (e.currentTarget.scrollTop > 0) return;
    const touch = e.touches[0]!;
    origin.current = { x: touch.clientX, y: touch.clientY };
  }

  function onTouchMove(e: TouchEvent<HTMLElement>) {
    const from = origin.current;
    if (!from) return;
    // A second finger (pinch/zoom) is never a pull.
    if (e.touches.length !== 1) return void reset();
    const touch = e.touches[0]!;
    const dy = touch.clientY - from.y;
    const dx = touch.clientX - from.x;

    if (!claimed.current) {
      // Upward or sideways: hand the gesture back for good rather than re-testing it,
      // so a scroll that returns to the top mid-flick can't turn into a pull.
      if (Math.abs(dx) > SLOP_PX || dy < -SLOP_PX) return void reset();
      if (dy < SLOP_PX) return;
      claimed.current = true;
      setDragging(true);
    }
    setDistance(Math.min(Math.max(dy, 0) * RESISTANCE, MAX_PX));
  }

  function onTouchEnd() {
    const committed = claimed.current && distance >= TRIGGER_PX;
    reset();
    if (!committed) return;
    hideAfter.current = Date.now() + MIN_VISIBLE_MS;
    setRefreshing(true);
    onRefresh();
  }

  function reset() {
    origin.current = null;
    claimed.current = false;
    setDragging(false);
    setDistance(0);
  }

  return {
    distance: refreshing ? RESTING_PX : distance,
    progress: Math.min(distance / TRIGGER_PX, 1),
    refreshing,
    dragging,
    handlers: { onTouchStart, onTouchMove, onTouchEnd },
  };
}
