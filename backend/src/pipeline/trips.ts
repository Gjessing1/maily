/**
 * Trip History — a read-only `derived`-stage projection over the `travel` enricher's
 * persisted output (ROADMAP Phase 4). The travel enricher normalises schema.org
 * reservations into `TravelReservation`s and stores them on `enrichments.result`; this
 * module reads them back, groups them into trips, and serves them newest-first for a
 * browsable travel timeline.
 *
 * **Pure retrieval, never a nudge.** The operational "add this flight to your calendar"
 * offer is Tier-0-only and lives in the Action Center; Trip History is the *search/browse*
 * half — historical trips you look up, not stale offers that pile up. So a years-deep
 * backfill correctly surfaces here (the enricher's `search` result lands on all tiers)
 * while emitting no proposals. Being a projection over already-enriched mail, it needs no
 * re-fetch and rebuilds for free via reindex (ARCHITECTURE §15).
 *
 * **Grouping is deterministic** (no LLM): reservations sharing a confirmation number are
 * one trip (a round-trip's two legs share a PNR), and the remaining units merge by date
 * proximity (overlapping/adjacent bookings = the same trip). Getting this from a flat
 * list to "grouped by trip" is the only real logic here, kept pure + unit-tested below.
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { TripDto, TripReservationDto } from '@maily/shared';
import { db } from '../db/client.js';
import { enrichments, messages } from '../db/schema.js';
import type { TravelReservation } from './enrichers/travel.js';

/** The persisted shape of the travel enricher's `result` JSON. */
interface TravelResult {
  reservations: TravelReservation[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Two date-bounded units (each already PNR-merged) join into one trip when the gap
 * between them is within this many days. Kept small: round trips are already bridged by
 * their shared confirmation number, and same-trip bookings (flight + hotel) overlap in
 * date — so only genuinely close bookings merge, and distinct trips weeks apart don't.
 */
const TRIP_MERGE_GAP_DAYS = 2;

/** Epoch-ms of an ISO string, or null. */
function ms(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** The reservation's effective timeline position: its start, else the mail's arrival. */
function effectiveStart(r: TripReservationDto): number | null {
  return ms(r.startsAt) ?? ms(r.receivedAt);
}

/** The reservation's effective end: its end, else its start, else the mail's arrival. */
function effectiveEnd(r: TripReservationDto): number | null {
  return ms(r.endsAt) ?? ms(r.startsAt) ?? ms(r.receivedAt);
}

/** A date-bounded cluster of reservations (a PNR group, or a merged trip). */
interface Unit {
  reservations: TripReservationDto[];
  start: number | null;
  end: number | null;
}

/** Min of two bounds, treating null as "unknown" (the other wins). */
function minBound(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}
function maxBound(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}

/** Bucket reservations by confirmation number (legs of one booking share a PNR). */
function unitsByReservationNumber(reservations: TripReservationDto[]): Unit[] {
  const byRef = new Map<string, TripReservationDto[]>();
  const units: Unit[] = [];
  for (const r of reservations) {
    // A null/blank ref isn't a grouping signal — each such reservation is its own unit.
    const ref = r.reservationNumber?.trim();
    if (!ref) {
      units.push(toUnit([r]));
      continue;
    }
    const bucket = byRef.get(ref);
    if (bucket) bucket.push(r);
    else byRef.set(ref, [r]);
  }
  for (const bucket of byRef.values()) units.push(toUnit(bucket));
  return units;
}

function toUnit(reservations: TripReservationDto[]): Unit {
  let start: number | null = null;
  let end: number | null = null;
  for (const r of reservations) {
    start = minBound(start, effectiveStart(r));
    end = maxBound(end, effectiveEnd(r));
  }
  return { reservations, start, end };
}

/** Choose a trip label: the destination stay/event if present, else the first leg. */
function tripTitle(reservations: TripReservationDto[]): string {
  const lodging = reservations.find((r) => r.type === 'lodging');
  if (lodging) return lodging.title;
  const event = reservations.find((r) => r.type === 'event');
  if (event) return event.title;
  return reservations[0]?.title ?? 'Trip';
}

const iso = (msVal: number | null): string | null =>
  msVal == null ? null : new Date(msVal).toISOString();

/** Build the client DTO for one merged trip cluster. */
function toTripDto(reservations: TripReservationDto[]): TripDto {
  const ordered = [...reservations].sort(
    (a, b) => (effectiveStart(a) ?? 0) - (effectiveStart(b) ?? 0),
  );
  // Span uses only *real* reservation dates (not the receivedAt fallback) so an
  // undated-but-recently-arrived trip shows no spurious span.
  let startsAt: number | null = null;
  let endsAt: number | null = null;
  for (const r of ordered) {
    startsAt = minBound(startsAt, ms(r.startsAt));
    endsAt = maxBound(endsAt, ms(r.endsAt) ?? ms(r.startsAt));
  }
  const first = ordered[0]!;
  return {
    id: `${first.messageId}:${first.startsAt ?? first.receivedAt ?? 'x'}`,
    title: tripTitle(ordered),
    startsAt: iso(startsAt),
    endsAt: iso(endsAt),
    reservations: ordered,
  };
}

/**
 * Group flat reservations into trips: PNR buckets first, then merge date-adjacent units.
 * Returns trips newest-first. Pure (no I/O) so it's unit-testable in isolation.
 */
export function groupTrips(reservations: TripReservationDto[]): TripDto[] {
  if (reservations.length === 0) return [];

  // Units with a timeline position cluster by date; fully-undated units stand alone.
  const units = unitsByReservationNumber(reservations);
  const dated = units.filter((u) => u.start != null).sort((a, b) => a.start! - b.start!);
  const undated = units.filter((u) => u.start == null);

  const gap = TRIP_MERGE_GAP_DAYS * DAY_MS;
  const clusters: Unit[] = [];
  for (const unit of dated) {
    const open = clusters[clusters.length - 1];
    if (open && unit.start! - (open.end ?? open.start!) <= gap) {
      open.reservations.push(...unit.reservations);
      open.end = maxBound(open.end, unit.end);
    } else {
      clusters.push({ ...unit, reservations: [...unit.reservations] });
    }
  }

  const trips = [...clusters, ...undated].map((u) => toTripDto(u.reservations));
  // Newest-first by effective start; undated trips (null) sink to the bottom.
  return trips.sort((a, b) => (ms(b.startsAt) ?? -Infinity) - (ms(a.startsAt) ?? -Infinity));
}

/** Parse a stored travel `result`, tolerating null/garbage (returns [] on either). */
function parseReservations(json: string | null): TravelReservation[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as TravelResult;
    return Array.isArray(parsed?.reservations) ? parsed.reservations : [];
  } catch {
    return [];
  }
}

/**
 * Read every `travel` reservation from the enrichment ledger (live, non-deleted source
 * mail only) and group it into the Trip History timeline. A pure read — the heavy
 * extraction already ran in the pipeline worker.
 */
export function listTrips(): TripDto[] {
  const rows = db
    .select({
      result: enrichments.result,
      messageId: enrichments.messageId,
      receivedAt: messages.receivedAt,
    })
    .from(enrichments)
    .innerJoin(messages, eq(enrichments.messageId, messages.id))
    .where(
      and(
        eq(enrichments.enricher, 'travel'),
        eq(enrichments.status, 'ok'),
        isNull(messages.deletedAt),
      ),
    )
    .all();

  const flat: TripReservationDto[] = [];
  for (const row of rows) {
    const receivedAt = row.receivedAt ? row.receivedAt.toISOString() : null;
    for (const r of parseReservations(row.result)) {
      flat.push({
        type: r.type,
        reservationNumber: r.reservationNumber,
        title: r.title,
        startsAt: r.startsAt,
        endsAt: r.endsAt,
        location: r.location,
        messageId: row.messageId,
        receivedAt,
      });
    }
  }
  return groupTrips(flat);
}
