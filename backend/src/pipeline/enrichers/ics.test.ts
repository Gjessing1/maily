/**
 * `ics` enricher coverage (ROADMAP Phase 4). Pure unit tests over the enricher's
 * `run` + the exported `parseCalendar` — no DB, no pipeline wiring (the framework's
 * queue/persist/tier path is covered by pipeline.test.ts). We pin: VEVENT field
 * extraction, date/date-time → ISO (UTC `Z`, naive local, all-day date-only), TEXT
 * unescaping + line unfolding, nested-VALARM isolation, method discipline
 * (REQUEST/PUBLISH/none offer; CANCEL/REPLY don't), multi-VEVENT, and the `applies`
 * gate. The proposal payload is asserted VEVENT-shaped (shared with `travel`).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { icsEnricher, parseCalendar, type CalendarInvite, type IcsFacts } from './ics.js';
import type { CalendarEventDraft } from './travel.js';

/** Minimal PipelineMessage stub — only the calendar body the enricher reads. */
function msg(bodyCalendar: string | null): Parameters<typeof icsEnricher.run>[0]['message'] {
  return {
    id: 'm1',
    accountId: 'a1',
    threadId: null,
    subject: null,
    fromName: null,
    fromAddress: null,
    to: [],
    cc: [],
    snippet: null,
    bodyText: null,
    bodyHtml: null,
    bodyCalendar,
    inReplyTo: null,
    references: null,
    sentAt: null,
    receivedAt: null,
    sourcePath: null,
  };
}

interface RunResult {
  facts: IcsFacts;
  proposals: { type: string; title?: string; payload?: unknown }[];
}

function run(bodyCalendar: string | null): RunResult {
  const out = icsEnricher.run({ message: msg(bodyCalendar), tier: 0 });
  assert.ok(!(out instanceof Promise), 'ics.run should be synchronous');
  return { facts: out.result as IcsFacts, proposals: out.proposals ?? [] };
}

/** The sole event, asserting exactly one was parsed. */
function onlyEvent(facts: IcsFacts): CalendarInvite {
  assert.equal(facts.events.length, 1);
  const e = facts.events[0];
  assert.ok(e);
  return e;
}

/** Assemble a VCALENDAR from raw lines with CRLF endings (as on the wire). */
function ical(lines: string[]): string {
  return lines.join('\r\n');
}

const REQUEST = ical([
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'METHOD:REQUEST',
  'BEGIN:VEVENT',
  'UID:evt-1@example.com',
  'SUMMARY:Team Sync',
  'DTSTART:20260610T090000Z',
  'DTEND:20260610T093000Z',
  'LOCATION:Room 1',
  'ORGANIZER;CN=Alice:mailto:alice@example.com',
  'END:VEVENT',
  'END:VCALENDAR',
]);

test('ics: classification is operational (Tier-0 gated by the framework)', () => {
  assert.equal(icsEnricher.kind, 'operational');
});

test('ics: applies only when a captured calendar part carries a VEVENT', () => {
  assert.equal(icsEnricher.applies?.(msg(null)), false);
  assert.equal(icsEnricher.applies?.(msg('just some text')), false);
  assert.equal(icsEnricher.applies?.(msg(REQUEST)), true);
});

test('ics: a REQUEST invite yields one VEVENT-shaped calendar_event proposal', () => {
  const { facts, proposals } = run(REQUEST);
  assert.equal(facts.method, 'REQUEST');
  const e = onlyEvent(facts);
  assert.equal(e.uid, 'evt-1@example.com');
  assert.equal(e.summary, 'Team Sync');
  assert.equal(e.start, '2026-06-10T09:00:00Z');
  assert.equal(e.end, '2026-06-10T09:30:00Z');
  assert.equal(e.location, 'Room 1');
  assert.equal(e.organizer, 'Alice');
  assert.equal(e.allDay, false);

  assert.equal(proposals.length, 1);
  const p0 = proposals[0];
  assert.ok(p0);
  assert.equal(p0.type, 'calendar_event');
  assert.equal(p0.title, 'Team Sync');
  const p = p0.payload as CalendarEventDraft;
  assert.equal(p.summary, 'Team Sync');
  assert.equal(p.start, '2026-06-10T09:00:00Z');
  assert.equal(p.location, 'Room 1');
  assert.equal(p.source, 'invite');
  assert.match(p.description ?? '', /Organizer: Alice/);
});

test('ics: CANCEL records the event for provenance but offers no add', () => {
  const cancel = ical([
    'BEGIN:VCALENDAR',
    'METHOD:CANCEL',
    'BEGIN:VEVENT',
    'UID:evt-1@example.com',
    'SUMMARY:Team Sync',
    'DTSTART:20260610T090000Z',
    'END:VEVENT',
    'END:VCALENDAR',
  ]);
  const { facts, proposals } = run(cancel);
  assert.equal(facts.method, 'CANCEL');
  assert.equal(facts.events.length, 1);
  assert.equal(proposals.length, 0, 'a cancellation never proposes an add');
});

test('ics: a method-less part still offers (some senders omit METHOD)', () => {
  const noMethod = ical([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'SUMMARY:Lunch',
    'DTSTART:20260610T110000Z',
    'END:VEVENT',
    'END:VCALENDAR',
  ]);
  const { facts, proposals } = run(noMethod);
  assert.equal(facts.method, null);
  assert.equal(proposals.length, 1);
});

test('ics: all-day VALUE=DATE → date-only ISO and allDay=true', () => {
  const allDay = ical([
    'BEGIN:VCALENDAR',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    'SUMMARY:Holiday',
    'DTSTART;VALUE=DATE:20260617',
    'END:VEVENT',
    'END:VCALENDAR',
  ]);
  const e = onlyEvent(run(allDay).facts);
  assert.equal(e.start, '2026-06-17');
  assert.equal(e.allDay, true);
});

test('ics: a TZID-only DATE-TIME is kept naive (no fabricated offset)', () => {
  const tz = ical([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'SUMMARY:Standup',
    'DTSTART;TZID=Europe/Oslo:20260610T090000',
    'END:VEVENT',
    'END:VCALENDAR',
  ]);
  assert.equal(onlyEvent(run(tz).facts).start, '2026-06-10T09:00:00');
});

test('ics: unfolds continuation lines and unescapes TEXT (incl. Norwegian)', () => {
  // A folded DESCRIPTION (continuation line begins with a space) with escaped chars.
  const folded = ical([
    'BEGIN:VCALENDAR',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    'SUMMARY:Møte om årsbudsjett',
    'DESCRIPTION:Hei\\, vi sees i morgen.\\nTa med rapporten',
    ' \\; og kalkulatoren.',
    'DTSTART:20260610T090000Z',
    'END:VEVENT',
    'END:VCALENDAR',
  ]);
  const e = onlyEvent(run(folded).facts);
  assert.equal(e.summary, 'Møte om årsbudsjett');
  assert.equal(e.description, 'Hei, vi sees i morgen.\nTa med rapporten; og kalkulatoren.');
});

test('ics: a nested VALARM never leaks its SUMMARY/DESCRIPTION into the event', () => {
  const withAlarm = ical([
    'BEGIN:VCALENDAR',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    'SUMMARY:Dentist',
    'DTSTART:20260610T090000Z',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'DESCRIPTION:Reminder',
    'TRIGGER:-PT15M',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ]);
  const e = onlyEvent(run(withAlarm).facts);
  assert.equal(e.summary, 'Dentist');
  assert.equal(e.description, null, 'VALARM DESCRIPTION must not bleed in');
});

test('ics: multiple VEVENTs each produce a proposal', () => {
  const multi = ical([
    'BEGIN:VCALENDAR',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    'SUMMARY:First',
    'DTSTART:20260610T090000Z',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'SUMMARY:Second',
    'DTSTART:20260611T090000Z',
    'END:VEVENT',
    'END:VCALENDAR',
  ]);
  const { facts, proposals } = run(multi);
  assert.equal(facts.events.length, 2);
  assert.deepEqual(
    proposals.map((p) => p.title),
    ['First', 'Second'],
  );
});

test('ics: a substanceless event (no title, no start) is not offered', () => {
  const empty = ical([
    'BEGIN:VCALENDAR',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    'END:VEVENT',
    'END:VCALENDAR',
  ]);
  const { facts, proposals } = run(empty);
  const e = onlyEvent(facts); // still recorded for provenance
  assert.equal(e.summary, 'Event');
  assert.equal(proposals.length, 0);
});

test('parseCalendar: tolerates LF-only line endings', () => {
  const lf = [
    'BEGIN:VCALENDAR',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    'SUMMARY:LF only',
    'DTSTART:20260610T090000Z',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\n');
  assert.equal(onlyEvent(parseCalendar(lf)).summary, 'LF only');
});
