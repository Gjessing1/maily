/**
 * The spinner revealed above a list by {@link usePullToRefresh}. It occupies real
 * height rather than overlaying the list, so the rows visibly follow the finger.
 */
import type { PullToRefresh } from './usePullToRefresh';

export function PullToRefreshIndicator({
  distance,
  progress,
  refreshing,
  dragging,
}: Pick<PullToRefresh, 'distance' | 'progress' | 'refreshing' | 'dragging'>) {
  if (distance === 0) return null;
  return (
    <div
      className={`flex items-center justify-center overflow-hidden ${
        dragging ? '' : 'transition-[height] duration-200'
      }`}
      style={{ height: distance }}
    >
      <span
        className={`inline-block size-5 rounded-full border-2 border-faint border-t-transparent ${
          refreshing ? 'animate-spin' : ''
        }`}
        // Before the gesture commits the ring winds up with the pull; once it does,
        // it hands over to the same spinner the rest of the app uses.
        style={refreshing ? undefined : { opacity: progress, rotate: `${progress * 270}deg` }}
        role={refreshing ? 'status' : undefined}
        aria-label={refreshing ? 'Refreshing' : undefined}
      />
    </div>
  );
}
