/**
 * App-level owner of the Android system Back press.
 *
 * Most of what Back should dismiss — the folder drawer, a confirm dialog, the row
 * context menu, multi-select mode — is component state with no history entry behind
 * it, so neither the WebView's back/forward list nor React Router can see it. Those
 * components register a dismisser while they are open; Back runs the most recently
 * registered one and stops there. Only when nothing is registered does the caller
 * fall through to router navigation (see `useAndroidBackButton`).
 *
 * Registration order is *activation* order, not mount order: `useBackHandler` only
 * subscribes while `active` is true, so the last overlay opened is the first closed.
 */
import { useEffect, useRef } from 'react';

interface BackHandler {
  run: () => void;
}

const handlers: BackHandler[] = [];

/** Register a dismisser. Returns the unsubscribe; call it when the overlay closes. */
export function registerBackHandler(run: () => void): () => void {
  const handler: BackHandler = { run };
  handlers.push(handler);
  return () => {
    const at = handlers.indexOf(handler);
    if (at !== -1) handlers.splice(at, 1);
  };
}

/**
 * Run the innermost registered dismisser. Returns false when nothing was registered,
 * meaning Back was not consumed by transient UI.
 */
export function runBackHandler(): boolean {
  const handler = handlers.at(-1);
  if (!handler) return false;
  handler.run();
  return true;
}

/** Test seam: drop every registration (handlers outlive React in module scope). */
export function resetBackHandlers(): void {
  handlers.length = 0;
}

/**
 * Claim Back for as long as `active` is true. `onBack` is read through a ref so a new
 * closure on every render does not re-order the stack.
 */
export function useBackHandler(active: boolean, onBack: () => void): void {
  const latest = useRef(onBack);
  useEffect(() => {
    latest.current = onBack;
  });
  useEffect(() => {
    if (!active) return;
    return registerBackHandler(() => latest.current());
  }, [active]);
}
