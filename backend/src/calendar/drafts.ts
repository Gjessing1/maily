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
 * Reads the `enrichments` ledger (status='ok' result JSON); pure mapping helpers are
 * exported for tests.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { enrichments } from '../db/schema.js';
import type { MessageRow } from '../db/queries.js';
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

/** Parse a ledger `result` JSON column defensively (a bad row must not 500 the route). */
function parseResult<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * All draft suggestions for one message, best first. Always non-empty: the bare
 * message fallback closes the list, so the form opens pre-filled either way.
 */
export function eventDraftsForMessage(message: MessageRow): CalendarEventDraft[] {
  const rows = db
    .select({ enricher: enrichments.enricher, result: enrichments.result })
    .from(enrichments)
    .where(
      and(
        eq(enrichments.messageId, message.id),
        eq(enrichments.status, 'ok'),
        inArray(enrichments.enricher, ['ics', 'travel']),
      ),
    )
    .all();

  const drafts: CalendarEventDraft[] = [];
  const ics = parseResult<IcsFacts>(rows.find((r) => r.enricher === 'ics')?.result ?? null);
  if (ics?.events) drafts.push(...draftsFromIcs(ics));
  const travel = parseResult<{ reservations: TravelReservation[] }>(
    rows.find((r) => r.enricher === 'travel')?.result ?? null,
  );
  if (travel?.reservations) drafts.push(...draftsFromTravel(travel.reservations));

  drafts.push(draftFromMessage(message));
  return drafts;
}
