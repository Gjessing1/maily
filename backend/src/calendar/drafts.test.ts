/**
 * Characterization net for the pure draft mappers behind "Add to calendar":
 * enricher output → pre-filled VEVENT-shaped drafts. Pins the rules the form
 * relies on: CANCEL invites and start-less entries propose nothing, travel
 * reservations carry their booking reference into the description, and the
 * bare-message fallback always yields a usable draft.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { draftFromMessage, draftsFromIcs, draftsFromTravel } from './drafts.js';
import type { IcsFacts } from '../pipeline/enrichers/ics.js';
import type { TravelReservation } from '../pipeline/enrichers/travel.js';

const invite = (over: Partial<IcsFacts['events'][number]> = {}): IcsFacts['events'][number] => ({
  uid: 'abc',
  summary: 'Standup',
  start: '2026-06-10T09:00:00Z',
  end: '2026-06-10T09:15:00Z',
  location: null,
  description: null,
  organizer: null,
  allDay: false,
  ...over,
});

test('draftsFromIcs maps VEVENTs and skips start-less ones', () => {
  const drafts = draftsFromIcs({ method: 'REQUEST', events: [invite(), invite({ start: null })] });
  assert.equal(drafts.length, 1);
  assert.deepEqual(drafts[0], {
    summary: 'Standup',
    start: '2026-06-10T09:00:00Z',
    end: '2026-06-10T09:15:00Z',
    location: null,
    description: null,
    source: 'invite',
  });
});

test('draftsFromIcs proposes nothing for a CANCEL invite', () => {
  assert.deepEqual(draftsFromIcs({ method: 'CANCEL', events: [invite()] }), []);
});

test('draftsFromTravel maps reservations with the booking reference', () => {
  const res: TravelReservation = {
    type: 'flight',
    reservationNumber: 'ABC123',
    title: 'SK123 OSL→CPH',
    startsAt: '2026-07-01T10:00:00+02:00',
    endsAt: '2026-07-01T11:10:00+02:00',
    location: 'OSL',
  };
  const drafts = draftsFromTravel([res, { ...res, startsAt: null }]);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]!.summary, 'SK123 OSL→CPH');
  assert.equal(drafts[0]!.description, 'Reservation: ABC123');
  assert.equal(drafts[0]!.source, 'flight');
});

test('draftFromMessage falls back to the subject (or "Event")', () => {
  assert.equal(draftFromMessage({ subject: ' Dinner Friday ' }).summary, 'Dinner Friday');
  assert.equal(draftFromMessage({ subject: null }).summary, 'Event');
  assert.equal(draftFromMessage({ subject: null }).source, 'message');
});
