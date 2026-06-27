/**
 * Snippet generation guard. The inbox preview comes from {@link makeSnippet}, which
 * prefers a message's text/plain part. Some senders (e.g. Eloqua) leak an `<html …>`
 * tag into that plaintext alternative, which used to surface verbatim in the preview
 * ("<html xml:lang=…" instead of the readable preheader). These tests pin that a
 * contaminated plaintext part is stripped, while clean prose — including stray `<`/`>`
 * punctuation — is left untouched.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeSnippet } from './parse.js';

test('makeSnippet uses the plaintext part as-is when it is clean prose', () => {
  assert.equal(
    makeSnippet('Hello there, your order shipped.', '<p>ignored html</p>'),
    'Hello there, your order shipped.',
  );
});

test('makeSnippet does not mistake prose punctuation for markup', () => {
  assert.equal(
    makeSnippet('a < b and c > d, mail me at <name@x.test>', null),
    'a < b and c > d, mail me at <name@x.test>',
  );
});

test('makeSnippet strips a stray <html> tag leaking into a text/plain part', () => {
  // Real-world Eloqua breakage: the plaintext alternative starts with an HTML tag
  // before the readable preheader. The snippet must show the prose, not the tag.
  const dirtyText =
    '<html xml:lang="en" xmlns="http://www.w3.org/1999/xhtml" lang="en"> ' +
    'Ditt medlemskap utløper i dag | Vi vil høre om din opplevelse';
  assert.equal(
    makeSnippet(dirtyText, '<p>html body</p>'),
    'Ditt medlemskap utløper i dag | Vi vil høre om din opplevelse',
  );
});

test('makeSnippet falls back to stripped HTML when there is no plaintext part', () => {
  assert.equal(makeSnippet(null, '<p>Hi <b>there</b></p>'), 'Hi there');
});

test('makeSnippet returns null when nothing usable is present', () => {
  assert.equal(makeSnippet(null, null), null);
  assert.equal(makeSnippet('   ', ''), null);
});

test('makeSnippet truncates with an ellipsis past the max length', () => {
  const snip = makeSnippet('x'.repeat(250), null, 200);
  assert.equal(snip?.length, 201); // 200 chars + ellipsis
  assert.equal(snip?.endsWith('…'), true);
});
