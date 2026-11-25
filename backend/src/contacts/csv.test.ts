/**
 * CSV contacts codec: the tokenizer's RFC 4180 edge cases, header recognition for the
 * real-world exports (Google, Outlook, hand-made), and a lossless export → import trip.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { cardsToCsv, classifyHeader, csvToCards, normalizeBirthday, parseCsv } from './csv.js';
import type { EditableCard } from './vcard.js';

function card(over: Partial<EditableCard> = {}): EditableCard {
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

test('parseCsv handles quotes, doubled quotes, embedded breaks, CRLF, BOM, blank rows', () => {
  const text = '\uFEFFa,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\n\r\n1,,3';
  assert.deepEqual(parseCsv(text), [
    ['a', 'b', 'c'],
    ['x, y', 'say "hi"', 'line1\nline2'],
    ['1', '', '3'],
  ]);
});

test('parseCsv sniffs semicolon and tab delimiters', () => {
  assert.deepEqual(parseCsv('Name;Email\nKari;kari@x.no'), [
    ['Name', 'Email'],
    ['Kari', 'kari@x.no'],
  ]);
  assert.deepEqual(parseCsv('Name\tEmail\nKari\tkari@x.no'), [
    ['Name', 'Email'],
    ['Kari', 'kari@x.no'],
  ]);
});

test('classifyHeader recognises Google, Outlook and generic columns', () => {
  assert.deepEqual(classifyHeader('E-mail 2 - Value'), { kind: 'email', key: '2', part: 'value' });
  assert.deepEqual(classifyHeader('E-mail 2 - Label'), { kind: 'email', key: '2', part: 'label' });
  assert.deepEqual(classifyHeader('E-mail 3 Address'), { kind: 'email', key: '3', part: 'value' });
  assert.deepEqual(classifyHeader('Mobile Phone'), {
    kind: 'phone',
    key: 'mobile',
    part: 'value',
    label: 'Cell',
  });
  assert.deepEqual(classifyHeader('Business Fax'), {
    kind: 'phone',
    key: 'business fax',
    part: 'value',
    label: 'Fax',
  });
  assert.deepEqual(classifyHeader('Business Street 2'), {
    kind: 'adr',
    key: 'business',
    part: 'street',
    label: 'Work',
  });
  assert.deepEqual(classifyHeader('Address 1 - Postal Code'), {
    kind: 'adr',
    key: '1',
    part: 'postalCode',
  });
  assert.deepEqual(classifyHeader('Organization 1 - Name'), { kind: 'scalar', field: 'org' });
  assert.equal(classifyHeader('E-mail Type'), null);
  assert.equal(classifyHeader('Gender'), null);
});

test('csvToCards reads a Google export (multi-value cells, labels, system groups)', () => {
  const csv = [
    'First Name,Middle Name,Last Name,Organization Name,Organization Title,Birthday,Labels,E-mail 1 - Label,E-mail 1 - Value,Phone 1 - Label,Phone 1 - Value,Address 1 - Label,Address 1 - Street,Address 1 - City,Address 1 - Postal Code,Address 1 - Country',
    'Kari,,Nordmann,Acme,CTO,--05-17,Family ::: * myContacts,* Work,kari@acme.no ::: kari@home.no,Mobile,+47 900 00 000,Home,Storgata 1,Oslo,0150,Norway',
  ].join('\n');
  const [c] = csvToCards(csv);
  assert.deepEqual(c, {
    name: 'Kari Nordmann',
    nickname: null,
    org: 'Acme',
    title: 'CTO',
    emails: ['kari@acme.no', 'kari@home.no'],
    phones: [{ type: 'Mobile', value: '+47 900 00 000' }],
    urls: [],
    addresses: [
      {
        type: 'Home',
        street: 'Storgata 1',
        locality: 'Oslo',
        region: '',
        postalCode: '0150',
        country: 'Norway',
      },
    ],
    birthday: '--05-17',
    note: null,
    categories: ['Family'],
  });
});

test('csvToCards reads an Outlook export (honorific Title, split street, 0/0/00 birthday)', () => {
  const csv = [
    'Title,First Name,Last Name,Company,Job Title,Business Street,Business Street 2,Business City,Business Phone,Mobile Phone,E-mail Address,E-mail Type,E-mail 2 Address,Birthday',
    'Mr.,Ola,Hansen,Firma AS,Manager,Kongens gate 2,4. etg,Bergen,55 00 00 00,900 11 222,ola@firma.no,SMTP,ola@privat.no,0/0/00',
  ].join('\r\n');
  const [c] = csvToCards(csv);
  assert.equal(c!.name, 'Ola Hansen');
  assert.equal(c!.title, 'Manager'); // Job Title beats the honorific
  assert.deepEqual(c!.emails, ['ola@firma.no', 'ola@privat.no']);
  assert.deepEqual(c!.phones, [
    { type: 'Work', value: '55 00 00 00' },
    { type: 'Cell', value: '900 11 222' },
  ]);
  assert.equal(c!.addresses[0]!.street, 'Kongens gate 2\n4. etg');
  assert.equal(c!.addresses[0]!.type, 'Work');
  assert.equal(c!.birthday, null);
});

test('csvToCards reads a hand-made sheet and drops empty rows', () => {
  const cards = csvToCards('Name;Email;Phone\nKari;kari@x.no;123\n;;\nOla;;456');
  assert.equal(cards.length, 2);
  assert.deepEqual(cards[0]!.emails, ['kari@x.no']);
  assert.deepEqual(cards[1]!.phones, [{ type: null, value: '456' }]);
});

test('normalizeBirthday converts unambiguous shapes and keeps the rest', () => {
  assert.equal(normalizeBirthday('1990-05-17'), '1990-05-17');
  assert.equal(normalizeBirthday('5/7/1990'), '1990-05-07');
  assert.equal(normalizeBirthday('17.5.1990'), '1990-05-17');
  assert.equal(normalizeBirthday('0/0/00'), null);
  assert.equal(normalizeBirthday('spring'), 'spring');
});

test('cardsToCsv → csvToCards round-trips every modelled field except PHOTO', () => {
  const original = card({
    name: 'Åse Øvre-Ås',
    nickname: 'Åsa',
    org: 'Fjord, Ltd',
    title: 'Lead "Ops"',
    emails: ['ase@fjord.no', 'ase@home.no'],
    phones: [
      { type: 'Cell', value: '+47 900 00 000' },
      { type: null, value: '22 00 00 00' },
    ],
    urls: [{ type: 'Work', value: 'https://fjord.no' }],
    addresses: [
      {
        type: 'Home',
        street: 'Line 1\nLine 2',
        locality: 'Oslo',
        region: '',
        postalCode: '0150',
        country: 'Norway',
      },
    ],
    birthday: '1985-02-03',
    note: 'Met at conf;\nlikes coffee',
    categories: ['Work', 'Friends'],
  });
  const csv = cardsToCsv([original, card({ name: 'Solo', emails: ['solo@x.no'] })]);
  assert.ok(csv.startsWith('\uFEFF'));
  const back = csvToCards(csv);
  assert.equal(back.length, 2);
  assert.deepEqual(back[0], original);
  assert.deepEqual(back[1]!.emails, ['solo@x.no']);
  assert.deepEqual(back[1]!.addresses, []);
});
