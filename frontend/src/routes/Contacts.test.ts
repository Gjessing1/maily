/** The import banner names only the non-zero outcomes, in one sentence. */
import { expect, test } from 'vitest';
import { importSummary } from './Contacts';

const r = (o: Partial<Parameters<typeof importSummary>[0]>) => ({
  imported: 0,
  merged: 0,
  unchanged: 0,
  skipped: 0,
  ...o,
});

test('importSummary lists only the counts that happened', () => {
  expect(importSummary(r({ imported: 1 }))).toBe('Imported 1 new contact.');
  expect(importSummary(r({ imported: 3, merged: 1, unchanged: 2, skipped: 1 }))).toBe(
    'Imported 3 new contacts, updated 1 existing card, 2 already in contacts, skipped 1.',
  );
  expect(importSummary(r({ unchanged: 5 }))).toBe('5 already in contacts.');
  expect(importSummary(r({ merged: 2 }))).toBe('Updated 2 existing cards.');
  expect(importSummary(r({}))).toBe('No contacts imported.');
});
