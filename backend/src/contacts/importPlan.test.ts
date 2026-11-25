/**
 * Duplicate-aware import planning: email identity merges into existing cards, name-only
 * lookalikes do not, in-file repeats fold, and a re-import writes nothing.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContactCardDto } from '@maily/shared';
import { planImport } from './importPlan.js';
import type { EditableCard } from './vcard.js';

function entry(over: Partial<EditableCard> = {}): EditableCard {
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

function existing(uid: string, over: Partial<ContactCardDto> = {}): ContactCardDto {
  return {
    ...entry(),
    uid,
    addressbook: '/book/a/',
    addressbookName: 'A',
    photo: null,
    ...over,
  };
}

test('a new address is created; an entry without email is skipped', () => {
  const plan = planImport(
    [entry({ name: 'New', emails: ['new@x.no'] }), entry({ name: 'No mail' })],
    [existing('1', { emails: ['old@x.no'] })],
    '/book/a/',
  );
  assert.equal(plan.creates.length, 1);
  assert.equal(plan.skipped, 1);
  assert.equal(plan.merges.length, 0);
});

test('a shared address merges into the existing card, case-insensitively', () => {
  const target = existing('1', { name: 'Kari', emails: ['Kari@X.no'], phones: [] });
  const plan = planImport(
    [entry({ name: 'Kari N', emails: ['kari@x.no'], phones: [{ type: 'Cell', value: '900' }] })],
    [target],
    '/book/a/',
  );
  assert.equal(plan.creates.length, 0);
  assert.equal(plan.merges.length, 1);
  assert.equal(plan.merges[0]!.target, target);
  assert.equal(plan.merges[0]!.card.name, 'Kari'); // existing scalars win
  assert.deepEqual(plan.merges[0]!.card.phones, [{ type: 'Cell', value: '900' }]);
});

test('re-importing data the card already holds is unchanged, not a write', () => {
  const plan = planImport(
    [entry({ name: 'Kari', emails: ['kari@x.no'], phones: [{ type: 'Cell', value: '900' }] })],
    [
      existing('1', {
        name: 'Kari',
        emails: ['kari@x.no'],
        phones: [{ type: 'Cell', value: '+900' }],
      }),
    ],
    '/book/a/',
  );
  assert.equal(plan.unchanged, 1);
  assert.equal(plan.merges.length, 0);
  assert.equal(plan.creates.length, 0);
});

test('a matching name alone does not merge', () => {
  const plan = planImport(
    [entry({ name: 'Kari Nordmann', emails: ['kari2@x.no'] })],
    [existing('1', { name: 'Kari Nordmann', emails: ['kari1@x.no'] })],
    '/book/a/',
  );
  assert.equal(plan.creates.length, 1);
  assert.equal(plan.merges.length, 0);
});

test('rows sharing an address inside the file fold into one card', () => {
  const plan = planImport(
    [
      entry({ name: 'Ola', emails: ['ola@x.no'] }),
      entry({ name: 'Ola H', emails: ['OLA@x.no', 'ola@home.no'] }),
    ],
    [],
    null,
  );
  assert.equal(plan.creates.length, 1);
  assert.equal(plan.unchanged, 1);
  assert.deepEqual(plan.creates[0]!.emails, ['ola@x.no', 'ola@home.no']);
  assert.equal(plan.creates[0]!.name, 'Ola');
});

test('two entries hitting one existing card produce a single merge', () => {
  const plan = planImport(
    [
      entry({ emails: ['work@x.no'], org: 'Acme' }),
      entry({ emails: ['home@x.no'], birthday: '1990-01-01' }),
    ],
    [existing('1', { name: 'Kari', emails: ['work@x.no', 'home@x.no'] })],
    '/book/a/',
  );
  assert.equal(plan.merges.length, 1);
  assert.equal(plan.merges[0]!.card.org, 'Acme');
  assert.equal(plan.merges[0]!.card.birthday, '1990-01-01');
});

test('the copy in the target book is preferred when an address is in several books', () => {
  const inA = existing('a', { emails: ['kari@x.no'], addressbook: '/book/a/' });
  const inB = existing('b', {
    emails: ['kari@x.no'],
    addressbook: '/book/b/',
    org: 'Richer',
    note: 'More fields',
  });
  const plan = planImport([entry({ emails: ['kari@x.no'], title: 'CTO' })], [inA, inB], '/book/a/');
  assert.equal(plan.merges[0]!.target, inA);
});
