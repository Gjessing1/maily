/**
 * Resolves the effective colour theme from the user pref plus the live OS
 * `prefers-color-scheme`. When the pref is 'system' the resolved value tracks the
 * OS query reactively (useSyncExternalStore), so the app re-themes the instant the
 * device flips light/dark — no reload. Token values live in index.css; this module
 * only decides 'dark' vs 'light' and a pre-paint script in index.html mirrors it to
 * avoid a first-paint flash.
 *
 * Inside the Android APK that query cannot be trusted to move: the activity is
 * deliberately not recreated when the device flips (recreating reloads the app and
 * re-runs the SSO handshake — see android MailyTheme.java), and a WebView is then free
 * to leave an already-loaded page on the mode it launched in, which is what kept the APK
 * on the wrong theme until it was force-closed. The shell reports every flip outright
 * through the global installed below, and its report outranks the query from then on.
 */
import { useSyncExternalStore } from 'react';
import { setNativeSystemThemeHandler } from '../nativeAndroid';
import { usePrefs, type Theme } from './prefs';

export type ResolvedTheme = 'dark' | 'light';

const mql =
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

/** The device mode as last reported by the Android shell; null everywhere else. */
let reported: ResolvedTheme | null = null;
const listeners = new Set<() => void>();

if (typeof window !== 'undefined') {
  setNativeSystemThemeHandler((theme) => {
    const next: ResolvedTheme = theme === 'dark' ? 'dark' : 'light';
    if (next === reported) return;
    reported = next;
    for (const listener of [...listeners]) listener();
  });
}

function systemTheme(): ResolvedTheme {
  return reported ?? (mql?.matches ? 'dark' : 'light');
}

function subscribeSystem(onChange: () => void): () => void {
  mql?.addEventListener('change', onChange);
  listeners.add(onChange);
  return () => {
    mql?.removeEventListener('change', onChange);
    listeners.delete(onChange);
  };
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
