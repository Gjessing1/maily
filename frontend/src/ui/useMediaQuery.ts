/** Reactive CSS media-query match via useSyncExternalStore (re-renders on change). */
import { useSyncExternalStore } from 'react';

export function useMediaQuery(query: string): boolean {
  const mql = typeof window !== 'undefined' ? window.matchMedia(query) : null;
  return useSyncExternalStore(
    (cb) => {
      mql?.addEventListener('change', cb);
      return () => mql?.removeEventListener('change', cb);
    },
    () => mql?.matches ?? false,
    () => false,
  );
}
