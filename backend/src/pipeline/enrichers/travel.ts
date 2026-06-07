/**
 * `travel` — JSON-LD travel/reservation enricher (ROADMAP Phase 4).
 *
 * Deterministic extraction of schema.org reservation microdata that airlines,
 * hotels and ticketing sites embed in HTML mail as
 * `<script type="application/ld+json">` blocks (the same markup Gmail reads for its
 * trip highlights). We pull `FlightReservation`, `LodgingReservation` and
 * `EventReservation` nodes, normalise them into a small flat shape (the `result`,
 * which feeds the search index + provenance), and emit one `calendar_event`
 * proposal per reservation — an *offer* to add the trip to the calendar, surfaced
 * later by the Action Center and (on approval) PUT to Radicale.
 *
 * Classification: `operational`. The proposals are the operational artifact, so the
 * framework gates this enricher to Tier 0 (recent) mail — a years-deep backfill can
 * never surface a stale "add this flight to your calendar" offer (ARCHITECTURE §14).
 * The proposal payload (`CalendarEventDraft`) is deliberately VEVENT-shaped so the
 * CalDAV push reuses one representation, no translation layer (ROADMAP Phase 4).
 */
import type { Enricher, EnricherContext, EnricherResult, ProposalDraft } from '../types.js';
import {
  collectJsonLdNodes,
  isObject,
  str,
  typesOf,
  type JsonObject,
  type JsonValue,
} from './jsonld.js';

/** Reservation kinds we extract (schema.org `@type` → our tag). */
const RESERVATION_TYPES: Record<string, TravelReservation['type']> = {
  FlightReservation: 'flight',
  LodgingReservation: 'lodging',
  EventReservation: 'event',
};

/** A normalised reservation — flat, search-friendly, provider-agnostic. */
export interface TravelReservation {
  type: 'flight' | 'lodging' | 'event';
  /** Confirmation / booking reference, when present. */
  reservationNumber: string | null;
  /** Human label, e.g. "UA110 SFO→JFK", a hotel name, or an event name. */
  title: string;
  /** ISO 8601 start (departure / check-in / event start), when present. */
  startsAt: string | null;
  /** ISO 8601 end (arrival / check-out / event end), when present. */
  endsAt: string | null;
  /** Free-text place (airport pair, hotel address, venue), when derivable. */
  location: string | null;
}

/**
 * The derived `calendar_event` proposal payload — deliberately VEVENT-shaped
 * (SUMMARY/DTSTART/DTEND/LOCATION/DESCRIPTION) so the future Radicale CalDAV push
 * consumes it directly, no translation step (ROADMAP Phase 4 "one representation").
 */
export interface CalendarEventDraft {
  summary: string;
  /** ISO 8601 with offset where the source provided one. */
  start: string | null;
  end: string | null;
  location: string | null;
  description: string | null;
  /**
   * Provenance: what produced this draft. Travel reservations ('flight'|'lodging'|
   * 'event'); 'invite' is the deterministic ICS enricher (a parsed VEVENT). One
   * representation, shared so the CalDAV push consumes either without translation.
   */
  source: TravelReservation['type'] | 'invite';
}

/** Pick the best human name from a schema.org place/airport/airline node. */
function placeLabel(node: JsonValue): string | null {
  if (typeof node === 'string') return node.trim() || null;
  if (!isObject(node)) return null;
  // Airports prefer the IATA code (compact + searchable); else the name.
  const iata = str(node, 'iataCode');
  if (iata) return iata;
  const name = str(node, 'name');
  if (name) return name;
  return addressLabel(node['address']);
}

/** Flatten a PostalAddress (or string) into a single readable line. */
function addressLabel(node: JsonValue): string | null {
  if (typeof node === 'string') return node.trim() || null;
  if (!isObject(node)) return null;
  const parts = [
    'streetAddress',
    'addressLocality',
    'addressRegion',
    'postalCode',
    'addressCountry',
  ]
    .map((k) => str(node, k))
    .filter((p): p is string => Boolean(p));
  return parts.length ? parts.join(', ') : str(node, 'name');
}

/** The `reservationFor` payload — may be a single object or (rarely) an array; take the first. */
function reservationFor(node: JsonObject): JsonObject | null {
  const rf = node['reservationFor'];
  if (Array.isArray(rf)) return rf.find(isObject) ?? null;
  return isObject(rf) ? rf : null;
}

function extractFlight(node: JsonObject, forObj: JsonObject): TravelReservation {
  const dep = placeLabel(forObj['departureAirport']);
  const arr = placeLabel(forObj['arrivalAirport']);
  const airlineNode = forObj['airline'];
  const carrier = isObject(airlineNode)
    ? (str(airlineNode, 'iataCode') ?? str(airlineNode, 'name'))
    : placeLabel(airlineNode);
  const flightNo = str(forObj, 'flightNumber');
  const flightLabel = [carrier, flightNo].filter(Boolean).join('');
  const route = dep && arr ? `${dep}→${arr}` : (dep ?? arr);
  const title = [flightLabel, route].filter(Boolean).join(' ') || 'Flight';
  return {
    type: 'flight',
    reservationNumber: str(node, 'reservationNumber'),
    title,
    startsAt: str(forObj, 'departureTime'),
    endsAt: str(forObj, 'arrivalTime'),
    location: dep && arr ? `${dep} → ${arr}` : (dep ?? arr),
  };
}

function extractLodging(node: JsonObject, forObj: JsonObject): TravelReservation {
  const name = str(forObj, 'name') ?? 'Lodging';
  return {
    type: 'lodging',
    reservationNumber: str(node, 'reservationNumber'),
    title: name,
    // schema.org puts the dates on the reservation, not `reservationFor`.
    startsAt: str(node, 'checkinTime'),
    endsAt: str(node, 'checkoutTime'),
    location: addressLabel(forObj['address']),
  };
}

function extractEvent(node: JsonObject, forObj: JsonObject): TravelReservation {
  const name = str(forObj, 'name') ?? 'Event';
  return {
    type: 'event',
    reservationNumber: str(node, 'reservationNumber'),
    title: name,
    startsAt: str(forObj, 'startDate'),
    endsAt: str(forObj, 'endDate'),
    location: placeLabel(forObj['location']),
  };
}

/** Map one JSON-LD node to a normalised reservation, or null if it isn't one we handle. */
function extractReservation(node: JsonObject): TravelReservation | null {
  const kind = typesOf(node)
    .map((t) => RESERVATION_TYPES[t])
    .find((k): k is TravelReservation['type'] => Boolean(k));
  if (!kind) return null;
  const forObj = reservationFor(node) ?? {};
  if (kind === 'flight') return extractFlight(node, forObj);
  if (kind === 'lodging') return extractLodging(node, forObj);
  return extractEvent(node, forObj);
}

/** Build the VEVENT-shaped calendar offer from a reservation. */
function toCalendarDraft(r: TravelReservation): CalendarEventDraft {
  const ref = r.reservationNumber ? `Confirmation: ${r.reservationNumber}` : null;
  return {
    summary: r.title,
    start: r.startsAt,
    end: r.endsAt,
    location: r.location,
    description: ref,
    source: r.type,
  };
}

export const travelEnricher: Enricher = {
  name: 'travel',
  version: 1,
  kind: 'operational',
  // Cheap gate: only HTML bodies can carry JSON-LD, and the marker must be present.
  applies(message) {
    return Boolean(message.bodyHtml && message.bodyHtml.includes('application/ld+json'));
  },
  run(ctx: EnricherContext): EnricherResult {
    const html = ctx.message.bodyHtml;
    if (!html) return {};

    const reservations: TravelReservation[] = [];
    for (const node of collectJsonLdNodes(html)) {
      const r = extractReservation(node);
      if (r) reservations.push(r);
    }
    if (reservations.length === 0) return { result: { reservations: [] } };

    const proposals: ProposalDraft[] = reservations.map((r) => ({
      type: 'calendar_event',
      title: r.title,
      payload: toCalendarDraft(r),
    }));

    return { result: { reservations }, proposals };
  },
};
