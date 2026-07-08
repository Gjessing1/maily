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
  const snip = makeSnippet('x'.repeat(250), null, null, 200);
  assert.equal(snip?.length, 201); // 200 chars + ellipsis
  assert.equal(snip?.endsWith('…'), true);
});

test('makeSnippet decodes HTML entities beyond the basic four', () => {
  // Real-world Coop Medlem breakage: the HTML body opens with an &zwnj;&nbsp;
  // preheader-spacer run and encodes Norwegian letters as named entities; the
  // preview showed "&zwnj; &zwnj; …" soup instead of the preheader prose.
  const html =
    '<div>' +
    '&zwnj;&nbsp;'.repeat(18) +
    '&Auml;nglamark drikke - et forfriskende og &oslash;kologisk valg</div>';
  assert.equal(makeSnippet(null, html), 'Änglamark drikke - et forfriskende og økologisk valg');
});

test('makeSnippet strips raw zero-width characters from the preview', () => {
  assert.equal(
    makeSnippet('\u200C \u200C \u200B\uFEFF Sommertilbud på alt', null),
    'Sommertilbud på alt',
  );
});

test('makeSnippet strips mailparser link artifacts from the preview', () => {
  // mailparser renders <a href> in a derived text/plain part as `label [url]`.
  assert.equal(
    makeSnippet('Read the latest [https://email.example/c/eJw0z0] now', null),
    'Read the latest now',
  );
});

test('makeSnippet drops a leading copy of the subject (doubled-subject newsletter)', () => {
  // Real-world Self-Host Weekly breakage: the plaintext body repeats the subject
  // (followed by a tracking link) before the readable preheader. The preview must
  // surface the preheader, not the subject a second time.
  const body =
    '\n\n\n\nSelf-Host Weekly (26 June 2026) [https://email.mail.selfh.st/c/eJw0z0]\n\n\n' +
    "We've been trying to reach you about your self-hosted identity stack";
  assert.equal(
    makeSnippet(body, null, 'Self-Host Weekly (26 June 2026)'),
    "We've been trying to reach you about your self-hosted identity stack",
  );
});

test('makeSnippet keeps the subject when the body is only the subject', () => {
  assert.equal(makeSnippet('Order shipped', null, 'Order shipped'), 'Order shipped');
});

test('makeSnippet ignores a too-short subject when deduping', () => {
  // Guards against stripping a legitimate short opener that happens to match.
  assert.equal(makeSnippet('Hi there, welcome aboard', null, 'Hi'), 'Hi there, welcome aboard');
});
