/**
 * Event-draft suggestions for the reader's "Add to calendar" action: turn what the
 * deterministic enrichers already extracted from a message into pre-filled,
 * VEVENT-shaped drafts (one representation — `CalendarEventDraft`), so adding an
 * invite or a reservation to the calendar is a confirm, not a re-type.
 *
 * Sources, in suggestion order:
 *   1. `ics` enricher    — parsed VEVENTs from a `text/calendar` invite part;
 *   2. `travel` enricher — JSON-LD flight/lodging/event reservations;
 *   3. the bare message  — subject as summary, no dates (the user fills them in).
 *
 * Reads the ledger through `messageFacts` (pipeline/facts-read.ts); pure mapping
 * helpers are exported for tests.
 */
import type { MessageRow } from '../db/queries.js';
import { messageFacts } from '../pipeline/facts-read.js';
import type { CalendarEventDraft, TravelReservation } from '../pipeline/enrichers/travel.js';
import type { IcsFacts } from '../pipeline/enrichers/ics.js';

/** Map the `ics` enricher's parsed invite into drafts (one per VEVENT). */
export function draftsFromIcs(facts: IcsFacts): CalendarEventDraft[] {
  // A CANCEL invite proposes nothing to add.
  if (facts.method === 'CANCEL') return [];
  return facts.events
    .filter((e) => e.start !== null)
    .map((e) => ({
      summary: e.summary || 'Event',
      start: e.start,
      end: e.end,
      location: e.location,
      description: e.description,
      source: 'invite' as const,
    }));
}

/** Map the `travel` enricher's reservations into drafts (one per reservation). */
export function draftsFromTravel(reservations: TravelReservation[]): CalendarEventDraft[] {
  return reservations
    .filter((r) => r.startsAt !== null)
    .map((r) => ({
      summary: r.title,
      start: r.startsAt,
      end: r.endsAt,
      location: r.location,
      description: r.reservationNumber ? `Reservation: ${r.reservationNumber}` : null,
      source: r.type,
    }));
}

/** Last-resort draft from the bare message: subject as title, dates left to the user. */
export function draftFromMessage(message: Pick<MessageRow, 'subject'>): CalendarEventDraft {
  return {
    summary: message.subject?.trim() || 'Event',
    start: null,
    end: null,
    location: null,
    description: null,
    source: 'message',
  };
}

/**
 * All draft suggestions for one message, best first. Always non-empty: the bare
 * message fallback closes the list, so the form opens pre-filled either way.
 */
export function eventDraftsForMessage(message: MessageRow): CalendarEventDraft[] {
  const facts = messageFacts(message.id);
  const drafts: CalendarEventDraft[] = [];
  if (facts.ics) drafts.push(...draftsFromIcs(facts.ics));
  drafts.push(...draftsFromTravel(facts.travel));
  drafts.push(draftFromMessage(message));
  return drafts;
}
