/**
 * Answers the Android system Back press for the app.
 *
 * The native shell asks this handler on every press and acts on the answer, so the
 * question it puts is "did you consume it?" — true when Back moved inside Maily,
 * false when the app is at its root and the shell should leave.
 *
 * Order of resolution:
 *  1. transient UI registered through `useBackHandler` (drawer, dialogs, selection);
 *  2. React Router history, when this document has an entry to pop;
 *  3. the inbox, when Back happens on a deep link opened as the first entry;
 *  4. false — nothing left to pop, let the shell close Maily.
 *
 * Step 2 deliberately does not consult `WebView.canGoBack()`: the native side already
 * asked us first precisely because its back/forward list also contains the pages
 * before Maily (SSO, the previous origin), and popping into those looks like the app
 * hanging on a blank screen. React Router stamps a monotonic `idx` into every entry it
 * pushes, which tells us exactly how deep we are inside *this* app.
 */
import { useEffect, useRef } from 'react';
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { setNativeBackHandler } from '../nativeAndroid';
import { runBackHandler } from './backButton';

/** Depth of the current entry within React Router's stack, or null if unstamped. */
export function routerHistoryIndex(): number | null {
  const state = window.history.state as { idx?: unknown } | null;
  return typeof state?.idx === 'number' ? state.idx : null;
}

export function useAndroidBackButton(): void {
  const navigate = useNavigate();
  const location = useLocation();
  const navigationType = useNavigationType();

  // Fallback depth for entries React Router did not stamp — a hard reload lands on
  // whatever `idx` the previous document left behind, and a WebView restored from a
  // saved state can arrive with none at all.
  const depth = useRef(0);
  useEffect(() => {
    if (navigationType === 'PUSH') depth.current += 1;
    else if (navigationType === 'POP') depth.current = Math.max(0, depth.current - 1);
  }, [location.key, navigationType]);

  const pathname = useRef(location.pathname);
  useEffect(() => {
    pathname.current = location.pathname;
  }, [location.pathname]);

  useEffect(
    () =>
      setNativeBackHandler(() => {
        try {
          if (runBackHandler()) return true;
        } catch {
          // A dismisser that throws must not wedge Back — fall through to navigating.
        }
        if (Math.max(routerHistoryIndex() ?? 0, depth.current) > 0) {
          navigate(-1);
          return true;
        }
        if (pathname.current !== '/') {
          navigate('/', { replace: true });
          return true;
        }
        return false;
      }),
    [navigate],
  );
}
