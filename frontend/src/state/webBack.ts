/**
 * Browser Back for the composer on the web.
 *
 * On Android the shell asks the page before acting on Back (see androidBack.ts), so an
 * open sheet — the add-contact editor, the save/discard dialog, the send-later popover —
 * closes first and the composer itself goes through its unsaved-work check. A browser
 * asks nobody: Back (a phone's back gesture, a mouse's back button) pops history, and
 * none of those sheets own a history entry, so the press went straight past them and
 * out of `/compose`. Cancelling an add-contact sheet that way closed the draft.
 *
 * So while the composer is open it keeps one extra entry — a copy of its own, marked —
 * on top of the stack. Back pops that entry instead of the route; the listener below
 * hides that pop from React Router and hands the press to the same back-handler stack
 * Android uses, then puts the entry back if the composer is still open. Leaving on
 * purpose (send, discard, the ✕) steps back over both entries via `webBackSteps()`.
 *
 * Only one guard exists at a time; the composer is the only screen holding one.
 */
import { isNativeAndroid } from '../nativeAndroid';

interface Guard {
  /** React Router's key for the composer's own entry (the guard entry copies it). */
  key: unknown;
  onBack: () => void;
}

let guard: Guard | null = null;
/** Whether the marked entry is the current one — i.e. the next Back pops it. */
let onTop = false;
/** Set once the composer leaves on purpose, so its own navigation is not intercepted. */
let leaving = false;

const MARK = 'mailyBackGuard';

function state(): Record<string, unknown> | null {
  return (window.history.state as Record<string, unknown> | null) ?? null;
}

function pushGuard(): void {
  window.history.pushState({ ...state(), [MARK]: true }, '');
  onTop = true;
}

if (typeof window !== 'undefined') {
  // Registered at module load, before React Router mounts its own popstate listener,
  // and in the capture phase — so a pop of the guard entry can be stopped before the
  // router ever sees it (to the router it is not a navigation at all).
  window.addEventListener(
    'popstate',
    (event) => {
      if (!guard || leaving || !onTop) return;
      const current = state();
      if (current?.[MARK] || current?.key !== guard.key) {
        // Landed somewhere else (several steps at once, or Forward): not ours.
        onTop = Boolean(current?.[MARK]);
        return;
      }
      onTop = false;
      event.stopImmediatePropagation();
      guard.onBack();
      if (guard && !leaving) pushGuard();
    },
    { capture: true },
  );
}

/**
 * Keep a Back guard while the composer is mounted. `onBack` runs for a browser Back
 * press; it should do what Android Back does there. Returns the disarm.
 *
 * A no-op in the Android shell (which already asks the page about Back) and in a
 * detached composer window (which has no history to go back through).
 */
export function armWebBackGuard(onBack: () => void, enabled = true): () => void {
  if (!enabled || isNativeAndroid()) return () => undefined;
  leaving = false;
  const current = state();
  if (current?.[MARK]) {
    // Remounted onto an existing guard entry (StrictMode's double effect, or Back from a
    // screen opened on top of the composer): adopt it rather than stacking another.
    guard = { key: current.key, onBack };
    onTop = true;
  } else {
    guard = { key: current?.key, onBack };
    pushGuard();
  }
  const mine = guard;
  return () => {
    // The entry itself stays: removing it would be a history traversal of its own, and
    // a navigation that unmounted the composer may already have pushed past it.
    if (guard === mine) guard = null;
  };
}

/**
 * How many entries a deliberate exit from the composer must go back: two while the guard
 * is on top of the composer's own entry, else one. Also stops intercepting, so that
 * traversal reaches the router untouched.
 */
export function webBackSteps(): number {
  leaving = true;
  return guard && onTop ? 2 : 1;
}
