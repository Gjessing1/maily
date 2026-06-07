/**
 * VEVENT serialiser coverage (ROADMAP Phase 4 — CalDAV push). Pure unit tests over
 * `buildCalendar`: the three date regimes the parser emits (all-day date-only, floating
 * naive-local, zoned→UTC), DTEND omission, TEXT escaping, deep-link embedding (URL prop
 * only for absolute links), UID stability, and the no-start guard. No I/O.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCalendar, CalendarBuildError } from './vevent.js';
import type { CalendarEventDraft } from '../pipeline/enrichers/travel.js';

const NOW = new Date('2026-06-07T10:00:00Z');

function draft(over: Partial<CalendarEventDraft> = {}): CalendarEventDraft {
  return {
    summary: 'Standup',
    start: '2026-06-08T09:00:00Z',
    end: '2026-06-08T09:30:00Z',
    location: null,
    description: null,
    source: 'invite',
    ...over,
  };
}

function build(over: Partial<CalendarEventDraft> = {}, sourceLink: string | null = null): string {
  return buildCalendar({ uid: 'p1@maily', draft: draft(over), sourceLink, now: NOW });
}

test('wraps a VEVENT in a VCALENDAR with required props', () => {
  const ics = build();
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /VERSION:2\.0/);
  assert.match(ics, /BEGIN:VEVENT/);
  assert.match(ics, /UID:p1@maily/);
  assert.match(ics, /DTSTAMP:20260607T100000Z/);
  assert.match(ics, /SUMMARY:Standup/);
  assert.match(ics, /END:VEVENT/);
  assert.match(ics, /END:VCALENDAR/);
  assert.ok(ics.endsWith('\r\n'));
});

test('zoned start/end normalise to compact UTC', () => {
  const ics = build();
  assert.match(ics, /DTSTART:20260608T090000Z/);
  assert.match(ics, /DTEND:20260608T093000Z/);
});

test('offset times are converted to UTC', () => {
  const ics = build({ start: '2026-06-08T11:00:00+02:00', end: null });
  assert.match(ics, /DTSTART:20260608T090000Z/);
});

test('floating times stay naive (no Z, no shift)', () => {
  const ics = build({ start: '2026-06-08T09:00:00', end: '2026-06-08T10:00:00' });
  assert.match(ics, /DTSTART:20260608T090000(?!Z)/);
  assert.match(ics, /DTEND:20260608T100000(?!Z)/);
  assert.doesNotMatch(ics, /DTSTART:[0-9T]+Z/);
});

test('date-only start is an all-day VALUE=DATE', () => {
  const ics = build({ start: '2026-06-08', end: null });
  assert.match(ics, /DTSTART;VALUE=DATE:20260608/);
});

test('omits DTEND when the draft has no end', () => {
  const ics = build({ end: null });
  assert.doesNotMatch(ics, /DTEND/);
});

test('escapes TEXT specials in summary/location/description', () => {
  const ics = build({
    summary: 'Lunch; with, a\\b',
    location: 'Room 1, Floor 2',
    description: 'Line one\nLine two',
  });
  assert.match(ics, /SUMMARY:Lunch\\; with\\, a\\\\b/);
  assert.match(ics, /LOCATION:Room 1\\, Floor 2/);
  assert.match(ics, /DESCRIPTION:Line one\\nLine two/);
});

test('embeds an absolute deep link as both DESCRIPTION and URL', () => {
  const ics = build({}, 'https://mail.example.com/m/abc-123');
  assert.match(ics, /DESCRIPTION:Source: https:\/\/mail\.example\.com\/m\/abc-123/);
  assert.match(ics, /URL:https:\/\/mail\.example\.com\/m\/abc-123/);
});

test('a relative deep link goes in DESCRIPTION only (no URL prop)', () => {
  const ics = build({}, '/m/abc-123');
  assert.match(ics, /DESCRIPTION:Source: \/m\/abc-123/);
  assert.doesNotMatch(ics, /\r\nURL:/);
});

test('combines an existing description with the source link', () => {
  const ics = build({ description: 'Bring slides' }, '/m/x');
  assert.match(ics, /DESCRIPTION:Bring slides\\nSource: \/m\/x/);
});

test('folds long lines to <=75 octets with space continuation', () => {
  const ics = build({ summary: 'A'.repeat(120) });
  for (const line of ics.split('\r\n')) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `line too long: ${line.length}`);
  }
  // The folded value rejoins to the original (drop CRLF + leading space).
  assert.match(ics.replace(/\r\n /g, ''), new RegExp(`SUMMARY:${'A'.repeat(120)}`));
});

test('throws when the draft has no start date', () => {
  assert.throws(
    () => buildCalendar({ uid: 'p1@maily', draft: draft({ start: null }), sourceLink: null }),
    CalendarBuildError,
  );
});

test('falls back to "Event" when summary is empty', () => {
  const ics = build({ summary: '' });
  assert.match(ics, /SUMMARY:Event/);
});
