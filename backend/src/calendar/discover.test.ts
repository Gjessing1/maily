/**
 * Characterization net for the pure calendar discovery parse (`parseCalendars`).
 * Pins what the event-target picker relies on: only caldav `calendar` collections
 * that accept VEVENTs are returned (Radicale VTODO-only task lists are skipped),
 * the home-set self-entry is skipped, hrefs resolve to absolute, and displayname
 * falls back to the last path segment. Namespace prefixes vary across servers,
 * so the regexes are prefix-agnostic.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCalendars } from './discover.js';

const BASE = 'https://dav.example.com/lars/';

test('parseCalendars keeps only VEVENT calendars and resolves hrefs', () => {
  const xml = `<?xml version="1.0"?>
  <D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
    <D:response>
      <D:href>/lars/</D:href>
      <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat>
    </D:response>
    <D:response>
      <D:href>/lars/personal/</D:href>
      <D:propstat><D:prop>
        <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
        <D:displayname>Personal</D:displayname>
        <C:supported-calendar-component-set>
          <C:comp name="VEVENT"/><C:comp name="VJOURNAL"/>
        </C:supported-calendar-component-set>
      </D:prop></D:propstat>
    </D:response>
    <D:response>
      <D:href>/lars/tasks/</D:href>
      <D:propstat><D:prop>
        <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
        <D:displayname>Tasks</D:displayname>
        <C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set>
      </D:prop></D:propstat>
    </D:response>
    <D:response>
      <D:href>/lars/family/</D:href>
      <D:propstat><D:prop>
        <D:resourcetype><C:calendar/><D:collection/></D:resourcetype>
        <D:displayname>Family</D:displayname>
      </D:prop></D:propstat>
    </D:response>
  </D:multistatus>`;

  const calendars = parseCalendars(xml, BASE);
  assert.equal(calendars.length, 2); // self-entry and the VTODO-only task list are skipped
  assert.deepEqual(calendars[0], {
    href: 'https://dav.example.com/lars/personal/',
    displayName: 'Personal',
  });
  assert.deepEqual(calendars[1], {
    href: 'https://dav.example.com/lars/family/',
    displayName: 'Family',
  });
});

test('parseCalendars falls back to the last path segment when displayname is absent', () => {
  const xml = `<multistatus xmlns="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
    <response>
      <href>/lars/work-cal/</href>
      <propstat><prop><resourcetype><collection/><cal:calendar/></resourcetype></prop></propstat>
    </response>
  </multistatus>`;

  const calendars = parseCalendars(xml, BASE);
  assert.equal(calendars.length, 1);
  assert.equal(calendars[0]!.displayName, 'work-cal');
});

test('parseCalendars returns nothing when there are no calendar collections', () => {
  const xml = `<D:multistatus xmlns:D="DAV:">
    <D:response>
      <D:href>/lars/</D:href>
      <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat>
    </D:response>
  </D:multistatus>`;
  assert.deepEqual(parseCalendars(xml, BASE), []);
});
