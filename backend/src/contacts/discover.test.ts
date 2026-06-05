/**
 * Characterization net for the pure address-book discovery parse (`parseBooks`).
 * Pins the behaviour the multi-book sync relies on: only carddav `addressbook`
 * collections are returned, the home-set self-entry and non-book collections are
 * skipped, hrefs resolve to absolute, and displayname falls back to the last path
 * segment. Namespace prefixes vary across servers, so the regex is prefix-agnostic.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBooks } from './discover.js';

const BASE = 'https://dav.example.com/lars/';

test('parseBooks keeps only addressbook collections and resolves hrefs', () => {
  const xml = `<?xml version="1.0"?>
  <D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
    <D:response>
      <D:href>/lars/</D:href>
      <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat>
    </D:response>
    <D:response>
      <D:href>/lars/contacts/</D:href>
      <D:propstat><D:prop>
        <D:resourcetype><D:collection/><C:addressbook/></D:resourcetype>
        <D:displayname>Personal</D:displayname>
      </D:prop></D:propstat>
    </D:response>
    <D:response>
      <D:href>/lars/work/</D:href>
      <D:propstat><D:prop>
        <D:resourcetype><C:addressbook/><D:collection/></D:resourcetype>
        <D:displayname>Work Contacts</D:displayname>
      </D:prop></D:propstat>
    </D:response>
  </D:multistatus>`;

  const books = parseBooks(xml, BASE);
  assert.equal(books.length, 2); // the plain collection (home-set self) is skipped
  assert.deepEqual(books[0], {
    href: 'https://dav.example.com/lars/contacts/',
    displayName: 'Personal',
  });
  assert.deepEqual(books[1], {
    href: 'https://dav.example.com/lars/work/',
    displayName: 'Work Contacts',
  });
});

test('parseBooks falls back to the last path segment when displayname is absent', () => {
  const xml = `<multistatus xmlns="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
    <response>
      <href>/lars/family/</href>
      <propstat><prop><resourcetype><collection/><card:addressbook/></resourcetype></prop></propstat>
    </response>
  </multistatus>`;

  const books = parseBooks(xml, BASE);
  assert.equal(books.length, 1);
  assert.equal(books[0]!.displayName, 'family');
});

test('parseBooks returns nothing when there are no addressbook collections', () => {
  const xml = `<D:multistatus xmlns:D="DAV:">
    <D:response>
      <D:href>/lars/</D:href>
      <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat>
    </D:response>
  </D:multistatus>`;
  assert.deepEqual(parseBooks(xml, BASE), []);
});
