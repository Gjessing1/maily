/**
 * Characterization net for the merge field union (ROADMAP §A2). The contract the UI
 * promises the user is "nothing you typed is lost", so these pin the no-data-loss rules:
 * lists union, scalars fall back rather than overwrite, notes concatenate, and an
 * existing PHOTO is left untouched (it rides in the raw vCard, not in this payload).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContactCardDto } from '@maily/shared';
import { mergeCards } from './merge.js';

function card(uid: string, over: Partial<ContactCardDto> = {}): ContactCardDto {
  return {
    uid,
    name: null,
    emails: [],
    addressbook: null,
    addressbookName: null,
    nickname: null,
    org: null,
    title: null,
    phones: [],
    urls: [],
    addresses: [],
    birthday: null,
    note: null,
    categories: [],
    photo: null,
    ...over,
  };
}

test('lists union with the survivor first and case-insensitive dedup', () => {
  const merged = mergeCards([
    card('a', { emails: ['Alice@Example.com'], categories: ['Friends'] }),
    card('b', {
      emails: ['alice@example.com', 'alice@work.example'],
      categories: ['friends', 'Ski'],
    }),
  ]);
  assert.deepEqual(merged.emails, ['Alice@Example.com', 'alice@work.example']);
  assert.deepEqual(merged.categories, ['Friends', 'Ski']);
});

test('scalars take the survivor, then fall back instead of staying empty', () => {
  const merged = mergeCards([
    card('a', { name: 'Alice', org: null, birthday: null }),
    card('b', { name: 'Alice Smith', org: 'Example AS', birthday: '1990-04-01' }),
  ]);
  assert.equal(merged.name, 'Alice', 'survivor wins where it has a value');
  assert.equal(merged.org, 'Example AS', 'and inherits what it lacks');
  assert.equal(merged.birthday, '1990-04-01');
});

test('phones and urls dedup on identity, not on spelling', () => {
  const merged = mergeCards([
    card('a', { phones: [{ type: 'Mobile', value: '+47 22 00 00 00' }], urls: [] }),
    card('b', {
      phones: [{ type: 'Work', value: '+4722000000' }],
      urls: [
        { type: null, value: 'https://example.com/' },
        { type: 'Work', value: 'example.com' },
      ],
    }),
  ]);
  assert.deepEqual(merged.phones, [{ type: 'Mobile', value: '+47 22 00 00 00' }]);
  assert.deepEqual(merged.urls, [{ type: null, value: 'https://example.com/' }]);
});

test('distinct notes are kept, not overwritten', () => {
  const merged = mergeCards([
    card('a', { note: 'Met at the conference' }),
    card('b', { note: 'Prefers email' }),
    card('c', { note: 'Met at the conference' }),
  ]);
  assert.equal(merged.note, 'Met at the conference\n\nPrefers email');
});

test('addresses union but a repeat of the same address collapses', () => {
  const home = {
    type: 'Home',
    street: 'Storgata 1',
    locality: 'Oslo',
    region: '',
    postalCode: '0155',
    country: 'Norway',
  };
  const merged = mergeCards([
    card('a', { addresses: [home] }),
    card('b', { addresses: [{ ...home, type: 'Work', locality: 'oslo' }] }),
  ]);
  assert.equal(merged.addresses.length, 1);
});

test('an existing photo is left alone; a missing one is inherited', () => {
  const kept = mergeCards([
    card('a', { photo: 'data:image/jpeg;base64,AAAA' }),
    card('b', { photo: 'data:image/jpeg;base64,BBBB' }),
  ]);
  assert.equal(kept.photo, undefined, 'omitted ⇒ the survivor’s PHOTO line is preserved verbatim');

  const inherited = mergeCards([card('a'), card('b', { photo: 'data:image/jpeg;base64,BBBB' })]);
  assert.equal(inherited.photo, 'data:image/jpeg;base64,BBBB');
});

test('merging a single card is a no-op union of itself', () => {
  const merged = mergeCards([card('a', { name: 'Solo', emails: ['solo@example.com'] })]);
  assert.equal(merged.name, 'Solo');
  assert.deepEqual(merged.emails, ['solo@example.com']);
});
