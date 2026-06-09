/**
 * `ics` enricher coverage (ROADMAP Phase 4). Pure unit tests over the enricher's
 * `run` + the exported `parseCalendar` — no DB, no pipeline wiring (the framework's
 * queue/persist/tier path is covered by pipeline.test.ts). We pin: VEVENT field
 * extraction, date/date-time → ISO (UTC `Z`, naive local, all-day date-only), TEXT
 * unescaping + line unfolding, nested-VALARM isolation, the VCALENDAR METHOD capture,
 * multi-VEVENT, and the `applies` gate. The enricher is a passive `search`-kind
 * extractor: it persists the parsed facts (for index/provenance) and emits no proposals.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { icsEnricher, parseCalendar, type CalendarInvite, type IcsFacts } from './ics.js';

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

function run(bodyCalendar: string | null): IcsFacts {
  const out = icsEnricher.run({ message: msg(bodyCalendar), tier: 0 });
  assert.ok(!(out instanceof Promise), 'ics.run should be synchronous');
  return out.result as IcsFacts;
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

test('ics: classification is a passive search-kind extractor', () => {
  assert.equal(icsEnricher.kind, 'search');
});

test('ics: applies only when a captured calendar part carries a VEVENT', () => {
  assert.equal(icsEnricher.applies?.(msg(null)), false);
  assert.equal(icsEnricher.applies?.(msg('just some text')), false);
  assert.equal(icsEnricher.applies?.(msg(REQUEST)), true);
});

test('ics: a REQUEST invite is parsed into VEVENT fields + method', () => {
  const facts = run(REQUEST);
  assert.equal(facts.method, 'REQUEST');
  const e = onlyEvent(facts);
  assert.equal(e.uid, 'evt-1@example.com');
  assert.equal(e.summary, 'Team Sync');
  assert.equal(e.start, '2026-06-10T09:00:00Z');
  assert.equal(e.end, '2026-06-10T09:30:00Z');
  assert.equal(e.location, 'Room 1');
  assert.equal(e.organizer, 'Alice');
  assert.equal(e.allDay, false);
});

test('ics: CANCEL records the event + method for provenance', () => {
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
  const facts = run(cancel);
  assert.equal(facts.method, 'CANCEL');
  assert.equal(facts.events.length, 1);
});

test('ics: a method-less part is parsed (method null)', () => {
  const noMethod = ical([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'SUMMARY:Lunch',
    'DTSTART:20260610T110000Z',
    'END:VEVENT',
    'END:VCALENDAR',
  ]);
  const facts = run(noMethod);
  assert.equal(facts.method, null);
  assert.equal(facts.events.length, 1);
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
  const e = onlyEvent(run(allDay));
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
  assert.equal(onlyEvent(run(tz)).start, '2026-06-10T09:00:00');
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
  const e = onlyEvent(run(folded));
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
  const e = onlyEvent(run(withAlarm));
  assert.equal(e.summary, 'Dentist');
  assert.equal(e.description, null, 'VALARM DESCRIPTION must not bleed in');
});

test('ics: multiple VEVENTs are all parsed', () => {
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
  const facts = run(multi);
  assert.deepEqual(
    facts.events.map((e) => e.summary),
    ['First', 'Second'],
  );
});

test('ics: a titleless/startless VEVENT is still recorded for provenance', () => {
  const empty = ical([
    'BEGIN:VCALENDAR',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    'END:VEVENT',
    'END:VCALENDAR',
  ]);
  const e = onlyEvent(run(empty));
  assert.equal(e.summary, 'Event');
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
