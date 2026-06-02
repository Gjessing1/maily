/**
 * Resolves the effective colour theme from the user pref plus the live OS
 * `prefers-color-scheme`. When the pref is 'system' the resolved value tracks the
 * OS query reactively (useSyncExternalStore), so the app re-themes the instant the
 * device flips light/dark — no reload. Token values live in index.css; this module
 * only decides 'dark' vs 'light' and a pre-paint script in index.html mirrors it to
 * avoid a first-paint flash.
 */
import { useSyncExternalStore } from 'react';
import { usePrefs, type Theme } from './prefs';

export type ResolvedTheme = 'dark' | 'light';

const mql =
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

function systemTheme(): ResolvedTheme {
  return mql?.matches ? 'dark' : 'light';
}

function subscribeSystem(onChange: () => void): () => void {
  mql?.addEventListener('change', onChange);
  return () => mql?.removeEventListener('change', onChange);
}

/** Reactive OS preference (re-renders when the device theme flips). */
function useSystemTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribeSystem, systemTheme, systemTheme);
}

export function resolveTheme(pref: Theme, system: ResolvedTheme): ResolvedTheme {
  return pref === 'system' ? system : pref;
}

/** The theme actually in effect right now ('dark' | 'light'). */
export function useTheme(): ResolvedTheme {
  const pref = usePrefs().theme;
  const system = useSystemTheme();
  return resolveTheme(pref, system);
}
