/**
 * Characterization net for the pure vCard / CardDAV-multistatus codec (`vcard.ts`),
 * extracted from `carddav.ts` in Refactoring Phase 3. Tripwires, not specs: they pin
 * the current parse/serialise behaviour the CardDAV transport relies on — name
 * resolution (FN over N), email collection, group/param stripping, line unfolding,
 * XML-entity decoding, and the vCard 3.0 build round-trip.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildVCard,
  extractCards,
  mergeVCard,
  parseCardDetail,
  parseVCard,
  splitVCards,
  toEditableCard,
  type EditableCard,
} from './vcard.js';

const CRLF = '\r\n';

/** Minimal editable card with everything empty but the given overrides. */
function editable(over: Partial<EditableCard> = {}): EditableCard {
  return {
    name: null,
    nickname: null,
    org: null,
    title: null,
    emails: [],
    phones: [],
    urls: [],
    addresses: [],
    birthday: null,
    note: null,
    categories: [],
    ...over,
  };
}

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

test('parseVCard yields one email-less row for a card with no EMAIL', () => {
  const vcard = ['BEGIN:VCARD', 'UID:no-mail-1', 'FN:No Mail', 'END:VCARD'].join(CRLF);
  assert.deepEqual(parseVCard(vcard), [{ email: null, name: 'No Mail', vcardUid: 'no-mail-1' }]);
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
  const vcard = buildVCard(
    'uid-9',
    editable({ name: 'Alice Mary Example', emails: ['alice@example.com'] }),
  );
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
  const vcard = buildVCard(
    'uid-1',
    editable({ name: 'Doe, John; Jr', emails: ['john@example.com'] }),
  );
  assert.match(vcard, /FN:Doe\\, John\\; Jr/);
});

test('buildVCard emits rich fields and they round-trip through parseCardDetail', () => {
  const vcard = buildVCard(
    'uid-rich',
    editable({
      name: 'Rich Contact',
      emails: ['rich@example.com'],
      nickname: 'Richie',
      org: 'Acme Inc',
      title: 'Engineer',
      phones: [{ type: 'Cell', value: '+47 123 45 678' }],
      urls: [{ type: 'Home', value: 'https://example.com' }],
      addresses: [
        {
          type: 'Home',
          street: '1 Main St',
          locality: 'Oslo',
          region: '',
          postalCode: '0001',
          country: 'Norway',
        },
      ],
      birthday: '1990-04-01',
      note: 'a note',
      categories: ['Family', 'VIP'],
    }),
  );
  const d = parseCardDetail(vcard);
  assert.equal(d.name, 'Rich Contact');
  assert.equal(d.nickname, 'Richie');
  assert.equal(d.org, 'Acme Inc');
  assert.equal(d.title, 'Engineer');
  assert.deepEqual(d.emails, ['rich@example.com']);
  assert.deepEqual(d.phones, [{ type: 'Cell', value: '+47 123 45 678' }]);
  assert.deepEqual(d.urls, [{ type: 'Home', value: 'https://example.com' }]);
  assert.equal(d.addresses.length, 1);
  assert.equal(d.addresses[0]!.locality, 'Oslo');
  assert.equal(d.addresses[0]!.country, 'Norway');
  assert.equal(d.birthday, '1990-04-01');
  assert.equal(d.note, 'a note');
  assert.deepEqual(d.categories, ['Family', 'VIP']);
});

test('parseCardDetail builds a data URI from an inline base64 PHOTO', () => {
  const vcard = [
    'BEGIN:VCARD',
    'FN:Pic',
    'EMAIL:pic@example.com',
    'PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRg==',
    'END:VCARD',
  ].join(CRLF);
  const d = parseCardDetail(vcard);
  assert.equal(d.photo, 'data:image/jpeg;base64,/9j/4AAQSkZJRg==');
});

test('mergeVCard rewrites managed fields but preserves PHOTO and X-* extensions', () => {
  const original = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'UID:keep-uid',
    'FN:Old Name',
    'N:Name;Old;;;',
    'EMAIL:old@example.com',
    'PHOTO;ENCODING=b;TYPE=JPEG:AAAA',
    'X-CUSTOM-FIELD:custom value',
    'REV:20200101T000000Z',
    'END:VCARD',
  ].join(CRLF);

  const merged = mergeVCard(
    'keep-uid',
    original,
    editable({ name: 'New Name', emails: ['new@example.com'] }),
  );

  // Managed fields updated.
  assert.match(merged, /FN:New Name/);
  assert.match(merged, /EMAIL[^:]*:new@example.com/);
  assert.doesNotMatch(merged, /old@example.com/);
  assert.doesNotMatch(merged, /FN:Old Name/);
  // Unmodelled properties preserved verbatim.
  assert.match(merged, /UID:keep-uid/);
  assert.match(merged, /PHOTO;ENCODING=b;TYPE=JPEG:AAAA/);
  assert.match(merged, /X-CUSTOM-FIELD:custom value/);
  assert.match(merged, /REV:20200101T000000Z/);
});

test('mergeVCard sets a new PHOTO from a data URI when one is supplied', () => {
  const original = ['BEGIN:VCARD', 'UID:u', 'FN:Old', 'EMAIL:o@example.com', 'END:VCARD'].join(
    CRLF,
  );
  const merged = mergeVCard(
    'u',
    original,
    editable({ name: 'Old', emails: ['o@example.com'], photo: 'data:image/png;base64,ZZZZ' }),
  );
  assert.match(merged, /PHOTO;ENCODING=b;TYPE=PNG:ZZZZ/);
  // It round-trips back to a renderable data URI.
  assert.equal(parseCardDetail(merged).photo, 'data:image/png;base64,ZZZZ');
});

test('mergeVCard replaces an existing PHOTO and clears it on null', () => {
  const original = [
    'BEGIN:VCARD',
    'UID:u',
    'FN:Name',
    'EMAIL:n@example.com',
    'PHOTO;ENCODING=b;TYPE=JPEG:OLD',
    'END:VCARD',
  ].join(CRLF);
  const replaced = mergeVCard(
    'u',
    original,
    editable({ name: 'Name', emails: ['n@example.com'], photo: 'data:image/jpeg;base64,NEW' }),
  );
  assert.match(replaced, /PHOTO;ENCODING=b;TYPE=JPEG:NEW/);
  assert.doesNotMatch(replaced, /:OLD/);

  const cleared = mergeVCard(
    'u',
    original,
    editable({ name: 'Name', emails: ['n@example.com'], photo: null }),
  );
  assert.doesNotMatch(cleared, /PHOTO/);
});

test('buildVCard emits an inline PHOTO line for a data URI', () => {
  const vcard = buildVCard(
    'u',
    editable({ name: 'Pic', emails: ['p@example.com'], photo: 'data:image/jpeg;base64,QUJD' }),
  );
  assert.match(vcard, /PHOTO;ENCODING=b;TYPE=JPEG:QUJD/);
  assert.equal(parseCardDetail(vcard).photo, 'data:image/jpeg;base64,QUJD');
});

test('mergeVCard falls back to a from-scratch build when raw is missing', () => {
  const merged = mergeVCard('fresh', null, editable({ name: 'Fresh', emails: ['f@example.com'] }));
  assert.match(merged, /BEGIN:VCARD/);
  assert.match(merged, /UID:fresh/);
  assert.match(merged, /FN:Fresh/);
  const [row] = parseVCard(merged);
  assert.equal(row!.email, 'f@example.com');
});

test('splitVCards separates a multi-card .vcf into individual documents', () => {
  const file = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'FN:Alice',
    'EMAIL:alice@example.com',
    'END:VCARD',
    'BEGIN:VCARD',
    'VERSION:3.0',
    'FN:Bob',
    'EMAIL:bob@example.com',
    'END:VCARD',
  ].join(CRLF);
  const cards = splitVCards(file);
  assert.equal(cards.length, 2);
  assert.match(cards[0]!, /FN:Alice/);
  assert.match(cards[1]!, /FN:Bob/);
});

test('splitVCards returns nothing for a file with no card', () => {
  assert.deepEqual(splitVCards('not a vcard at all'), []);
});

test('toEditableCard narrows a parsed detail to the editable subset (drops uid, keeps photo)', () => {
  const vcard = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'UID:drop-me',
    'FN:Carol Smith',
    'EMAIL;TYPE=INTERNET:carol@example.com',
    'TEL;TYPE=CELL:+123',
    'PHOTO;ENCODING=b;TYPE=JPEG:AAAA',
    'END:VCARD',
  ].join(CRLF);
  const editableCard = toEditableCard(parseCardDetail(vcard));
  assert.equal(editableCard.name, 'Carol Smith');
  assert.deepEqual(editableCard.emails, ['carol@example.com']);
  assert.equal(editableCard.phones[0]!.value, '+123');
  // UID is a read-only identity extra; PHOTO is carried so an import/round-trip re-emits it.
  assert.equal('uid' in editableCard, false);
  assert.equal(editableCard.photo, 'data:image/jpeg;base64,AAAA');
});
