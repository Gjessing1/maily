/**
 * Approve-handler registry — the seam where a proposal's *side effect* on approval
 * lives, keyed by proposal `type` (ARCHITECTURE §14/§15, ROADMAP Phase 4).
 *
 * The Action Center route is type-agnostic: it records the approve/dismiss decision
 * and, on approve, looks up a handler here and runs it. A proposal whose type has NO
 * registered handler is still approvable — the offer is simply *acknowledged* with no
 * external effect. This is what lets new operational targets land without touching the
 * route or the data layer:
 *   - `calendar_event` registers a handler here (`calendar/caldav.ts`, wired at boot in
 *     index.ts) that PUTs the VEVENT-shaped payload to Radicale — but only when CalDAV is
 *     configured; unconfigured, the type stays handler-less and approval just acknowledges.
 *   - future `package_track` / RSVP / task handlers slot in the same way.
 *
 * Handlers run human-in-the-loop only (the user approved) and stay small + idempotent;
 * a throw is surfaced to the caller so the UI can report the side effect failed while
 * the approval itself still persists (the decision is the user's; the effect can retry).
 */

/** The proposal a handler acts on (parsed payload, not the raw DB row). */
export interface ApproveContext {
  id: string;
  messageId: string;
  type: string;
  title: string | null;
  /** Parsed proposal payload (e.g. a CalendarEventDraft for `calendar_event`). */
  payload: unknown;
}

export type ApproveHandler = (ctx: ApproveContext) => Promise<void> | void;

const handlers = new Map<string, ApproveHandler>();

/** Register (or replace) the approve side effect for a proposal type. */
export function registerApproveHandler(type: string, handler: ApproveHandler): void {
  handlers.set(type, handler);
}

/** Remove a handler (test cleanup / hot-swap). */
export function unregisterApproveHandler(type: string): void {
  handlers.delete(type);
}

/** The handler for a proposal type, or undefined when none is registered. */
export function approveHandlerFor(type: string): ApproveHandler | undefined {
  return handlers.get(type);
}

// The `calendar_event` handler is registered at boot by `calendar/caldav.ts` when CalDAV
// is configured (index.ts → registerCalendarApproveHandler). When it is not configured,
// no handler is registered, so approving a `calendar_event` acknowledges the offer
// (status → approved) without writing to Radicale.
