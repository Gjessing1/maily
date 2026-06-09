/**
 * `travel` — JSON-LD travel/reservation enricher (ROADMAP Phase 4).
 *
 * Deterministic extraction of schema.org reservation microdata that airlines,
 * hotels and ticketing sites embed in HTML mail as
 * `<script type="application/ld+json">` blocks (the same markup Gmail reads for its
 * trip highlights). We pull `FlightReservation`, `LodgingReservation` and
 * `EventReservation` nodes and normalise them into a small flat shape (the `result`,
 * which feeds the search index + provenance).
 *
 * Classification: `search` — a passive extractor that indexes reservations on all
 * tiers (old mail stays searchable). It emits no proposals. The VEVENT-shaped
 * `CalendarEventDraft` type defined here is the shared calendar representation (also
 * used by the `ics` enricher and the dormant CalDAV push in `calendar/caldav.ts`),
 * kept ready for the future calendar integration.
 */
import type { Enricher, EnricherContext, EnricherResult } from '../types.js';
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
   * 'event'); 'invite' is the deterministic ICS enricher (a parsed VEVENT);
   * 'message' is the bare-message fallback / a user-confirmed form. One
   * representation, shared so the CalDAV push consumes any without translation.
   */
  source: TravelReservation['type'] | 'invite' | 'message';
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

export const travelEnricher: Enricher = {
  name: 'travel',
  version: 2,
  kind: 'search',
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
    return { result: { reservations } };
  },
};
