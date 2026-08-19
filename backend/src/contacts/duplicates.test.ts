/**
 * Characterization net for duplicate clustering (ROADMAP §A2). Pins the three things
 * the passive flag depends on: what counts as a match (shared address, identical name),
 * that matching is transitive, and that a non-match never produces a group — a false
 * positive here would turn an advisory flag into noise the user has to dismiss.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContactCardDto } from '@maily/shared';
import { cardRichness, findDuplicateGroups, normalizeName } from './duplicates.js';

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

test('cards in different books sharing an address are one group', () => {
  const groups = findDuplicateGroups([
    card('a', { name: 'Alice Smith', emails: ['Alice@Example.com'], addressbook: '/personal/' }),
    card('b', { name: 'A. Smith', emails: ['alice@example.com'], addressbook: '/work/' }),
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0]!.sharedEmails, ['alice@example.com']);
  assert.equal(groups[0]!.sharedName, null, 'different display names — not a name match');
  assert.deepEqual(groups[0]!.cards.map((c) => c.uid).sort(), ['a', 'b']);
});

test('identical display names group even with different addresses', () => {
  const groups = findDuplicateGroups([
    card('a', { name: 'Bob Jones', emails: ['bob@home.example'], org: 'Example AS' }),
    card('b', { name: 'bob  jones', emails: ['b.jones@work.example'] }),
  ]);
  assert.equal(groups.length, 1);
  // The label is the leading card's name — the same one `mergeCards` keeps — so what the
  // flag calls the person is what the merged card ends up called.
  assert.equal(groups[0]!.sharedName, 'Bob Jones');
  assert.deepEqual(groups[0]!.sharedEmails, [], 'no address is actually shared');
});

test('matching is transitive across reasons', () => {
  const groups = findDuplicateGroups([
    card('a', { name: 'Carol', emails: ['carol@example.com'] }),
    card('b', { name: 'Carol Danvers', emails: ['carol@example.com'] }),
    card('c', { name: 'carol danvers', emails: ['cd@other.example'] }),
  ]);
  assert.equal(groups.length, 1, 'a–b by address, b–c by name is one person');
  assert.equal(groups[0]!.cards.length, 3);
});

test('unrelated cards produce no groups', () => {
  const groups = findDuplicateGroups([
    card('a', { name: 'Alice', emails: ['alice@example.com'] }),
    card('b', { name: 'Bob', emails: ['bob@example.com'] }),
    card('c', {}),
    card('d', {}),
  ]);
  assert.deepEqual(groups, [], 'two nameless, addressless cards are not duplicates of each other');
});

test('the fullest card leads its group, so the merge default is the richest', () => {
  const thin = card('thin', { name: 'Dana', emails: ['dana@example.com'] });
  const full = card('full', {
    name: 'Dana',
    emails: ['dana@example.com', 'dana@work.example'],
    phones: [{ type: 'Mobile', value: '+4712345678' }],
    org: 'Example AS',
  });
  const groups = findDuplicateGroups([thin, full]);
  assert.equal(groups[0]!.cards[0]!.uid, 'full');
  assert.ok(cardRichness(full) > cardRichness(thin));
});

test('normalizeName folds case, accents, punctuation and spacing', () => {
  assert.equal(normalizeName('  Renée   O.  Dupont '), 'renee o dupont');
  assert.equal(normalizeName(null), '');
});
