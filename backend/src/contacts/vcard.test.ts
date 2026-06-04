/**
 * Characterization net for the pure vCard / CardDAV-multistatus codec (`vcard.ts`),
 * extracted from `carddav.ts` in Refactoring Phase 3. Tripwires, not specs: they pin
 * the current parse/serialise behaviour the CardDAV transport relies on — name
 * resolution (FN over N), email collection, group/param stripping, line unfolding,
 * XML-entity decoding, and the vCard 3.0 build round-trip.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildVCard, extractCards, parseVCard } from './vcard.js';

const CRLF = '\r\n';

test('parseVCard prefers FN, collects EMAILs, captures UID', () => {
  const vcard = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'UID:abc-123',
    'N:Example;Alice;;;',
    'FN:Alice Example',
    'EMAIL;TYPE=INTERNET:alice@example.com',
    'EMAIL;TYPE=work:alice@work.example.com',
    'END:VCARD',
  ].join(CRLF);

  const rows = parseVCard(vcard);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.name, 'Alice Example');
    assert.equal(r.vcardUid, 'abc-123');
  }
  assert.deepEqual(
    rows.map((r) => r.email),
    ['alice@example.com', 'alice@work.example.com'],
  );
});

test('parseVCard falls back to "Given Family" from N when FN is absent', () => {
  const vcard = ['BEGIN:VCARD', 'N:Example;Alice;;;', 'EMAIL:alice@example.com', 'END:VCARD'].join(
    CRLF,
  );
  const [row] = parseVCard(vcard);
  assert.equal(row!.name, 'Alice Example');
});

test('parseVCard strips item-group prefixes and parameters from EMAIL', () => {
  const vcard = [
    'BEGIN:VCARD',
    'FN:Grouped',
    'item1.EMAIL;TYPE=home:home@example.com',
    'END:VCARD',
  ].join(CRLF);
  const [row] = parseVCard(vcard);
  assert.equal(row!.email, 'home@example.com');
});

test('parseVCard unfolds RFC 6350 continuation lines', () => {
  const vcard = ['BEGIN:VCARD', 'FN:Very Long', ' Name', 'EMAIL:x@example.com', 'END:VCARD'].join(
    CRLF,
  );
  const [row] = parseVCard(vcard);
  assert.equal(row!.name, 'Very LongName');
});

test('parseVCard yields no rows for a card with no EMAIL', () => {
  const vcard = ['BEGIN:VCARD', 'FN:No Mail', 'END:VCARD'].join(CRLF);
  assert.deepEqual(parseVCard(vcard), []);
});

test('extractCards pulls href/etag/vcard per response and decodes entities', () => {
  const xml = `<?xml version="1.0"?>
  <D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
    <D:response>
      <D:href>/book/card1.vcf</D:href>
      <D:propstat>
        <D:prop>
          <D:getetag>"etag-1"</D:getetag>
          <C:address-data>BEGIN:VCARD&#13;&#10;FN:A &amp; B&#13;&#10;EMAIL:ab@example.com&#13;&#10;END:VCARD</C:address-data>
        </D:prop>
      </D:propstat>
    </D:response>
    <D:response>
      <D:href>/book/</D:href>
    </D:response>
  </D:multistatus>`;

  const cards = extractCards(xml);
  assert.equal(cards.length, 1); // collection self-entry (no address-data) skipped
  assert.equal(cards[0]!.href, '/book/card1.vcf');
  assert.equal(cards[0]!.etag, '"etag-1"');
  const [row] = parseVCard(cards[0]!.vcard);
  assert.equal(row!.name, 'A & B');
  assert.equal(row!.email, 'ab@example.com');
});

test('buildVCard emits a 3.0 card with derived N and round-trips through parseVCard', () => {
  const vcard = buildVCard('uid-9', 'Alice Mary Example', ['alice@example.com']);
  assert.match(vcard, /VERSION:3\.0/);
  assert.match(vcard, /UID:uid-9/);
  assert.match(vcard, /FN:Alice Mary Example/);
  // N = last token family, the rest given.
  assert.match(vcard, /N:Example;Alice Mary;;;/);

  const [row] = parseVCard(vcard);
  assert.equal(row!.name, 'Alice Mary Example');
  assert.equal(row!.email, 'alice@example.com');
  assert.equal(row!.vcardUid, 'uid-9');
});

test('buildVCard escapes commas and semicolons in the display name', () => {
  const vcard = buildVCard('uid-1', 'Doe, John; Jr', ['john@example.com']);
  assert.match(vcard, /FN:Doe\\, John\\; Jr/);
});
