/**
 * Trip-grouping unit tests (ROADMAP Phase 4 Trip History). Cover the deterministic
 * clustering: confirmation-number bridging (round trips), date-proximity merging,
 * separation of distinct trips, title selection, span computation, and ordering.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { TripReservationDto } from '@maily/shared';
import { groupTrips } from './trips.js';

let seq = 0;
function res(over: Partial<TripReservationDto> = {}): TripReservationDto {
  return {
    type: 'flight',
    reservationNumber: null,
    title: 'Flight',
    startsAt: null,
    endsAt: null,
    location: null,
    messageId: `m${seq++}`,
    receivedAt: null,
    ...over,
  };
}

test('groupTrips: returns nothing for no reservations', () => {
  assert.deepEqual(groupTrips([]), []);
});

test('groupTrips: bridges a round trip via shared confirmation number despite a long gap', () => {
  const trips = groupTrips([
    res({ reservationNumber: 'ABC123', title: 'UA1 SFO→JFK', startsAt: '2026-03-01T08:00:00Z' }),
    res({ reservationNumber: 'ABC123', title: 'UA2 JFK→SFO', startsAt: '2026-03-12T18:00:00Z' }),
  ]);
  assert.equal(trips.length, 1);
  assert.equal(trips[0]!.reservations.length, 2);
  assert.equal(trips[0]!.startsAt, '2026-03-01T08:00:00.000Z');
  assert.equal(trips[0]!.endsAt, '2026-03-12T18:00:00.000Z');
});

test('groupTrips: merges date-overlapping bookings with no shared ref into one trip', () => {
  const trips = groupTrips([
    res({ type: 'flight', title: 'Flight out', startsAt: '2026-05-01T06:00:00Z' }),
    res({
      type: 'lodging',
      title: 'Grand Hotel',
      startsAt: '2026-05-01T15:00:00Z',
      endsAt: '2026-05-04T10:00:00Z',
    }),
  ]);
  assert.equal(trips.length, 1);
  // Lodging title wins as the trip label (the destination stay).
  assert.equal(trips[0]!.title, 'Grand Hotel');
});

test('groupTrips: keeps distinct trips weeks apart separate, newest first', () => {
  const trips = groupTrips([
    res({ title: 'Spring', startsAt: '2026-03-01T08:00:00Z' }),
    res({ title: 'Summer', startsAt: '2026-07-01T08:00:00Z' }),
  ]);
  assert.equal(trips.length, 2);
  assert.equal(trips[0]!.title, 'Summer');
  assert.equal(trips[1]!.title, 'Spring');
});

test('groupTrips: sinks fully-undated reservations to the bottom', () => {
  const trips = groupTrips([
    res({ title: 'Undated', startsAt: null, receivedAt: null }),
    res({ title: 'Dated', startsAt: '2026-04-01T08:00:00Z' }),
  ]);
  assert.deepEqual(
    trips.map((t) => t.title),
    ['Dated', 'Undated'],
  );
  assert.equal(trips[1]!.startsAt, null);
});

test('groupTrips: does not span the trip from a receivedAt fallback', () => {
  const trips = groupTrips([
    res({ title: 'No real dates', startsAt: null, receivedAt: '2026-02-01T00:00:00Z' }),
  ]);
  assert.equal(trips.length, 1);
  assert.equal(trips[0]!.startsAt, null);
  assert.equal(trips[0]!.endsAt, null);
});
