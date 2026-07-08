/**
 * Query IR parser coverage (ROADMAP §3.7.D / Query Contract Layer). Pins the
 * operator grammar — the contract every consumer (UI search, the advanced-search
 * form, future NL→query) builds against — so an operator can't silently change
 * meaning. Pure tests: parse only, no DB.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { isEmptyQuery, parseDate, parseQuery, parseSize } from './query.js';

const NOW = Date.UTC(2026, 5, 10); // 2026-06-10

test('free text: bare and quoted terms', () => {
  const ir = parseQuery('hotel "boarding pass"');
  assert.deepEqual(ir.terms, ['hotel', 'boarding pass']);
  assert.equal(isEmptyQuery(ir), false);
});

test('field operators: from/to/subject, quoted values', () => {
  const ir = parseQuery('from:alice to:"bob jones" subject:invoice-draft');
  assert.equal(ir.from, 'alice');
  assert.equal(ir.to, 'bob jones');
  assert.equal(ir.subject, 'invoice-draft');
  assert.deepEqual(ir.terms, []);
});

test('date bounds: absolute and relative', () => {
  const ir = parseQuery('since:2026-01-01 before:7d', NOW);
  assert.equal(ir.sinceMs, Date.UTC(2026, 0, 1));
  assert.equal(ir.beforeMs, NOW - 7 * 86_400_000);
});

test('attachment operators: has/larger/smaller/size', () => {
  assert.equal(parseQuery('has:attachment').hasAttachment, true);
  assert.equal(parseQuery('larger:2M').minAttachmentSize, 2 * 1024 * 1024);
  assert.equal(parseQuery('smaller:500k').maxAttachmentSize, 500 * 1024);
  assert.equal(parseQuery('size:<1M').maxAttachmentSize, 1024 * 1024);
  assert.equal(parseQuery('size:>1M').minAttachmentSize, 1024 * 1024);
});

test('is: state filters — unread/read/flagged/starred/answered', () => {
  assert.equal(parseQuery('is:unread').unread, true);
  assert.equal(parseQuery('is:read').unread, false);
  assert.equal(parseQuery('is:flagged').flagged, true);
  assert.equal(parseQuery('is:starred').flagged, true);
  assert.equal(parseQuery('is:answered').answered, true);
  // Unknown state degrades to a free-text term, never a silent drop.
  assert.deepEqual(parseQuery('is:blue').terms, ['is:blue']);
});

test('in:trash scope operator; unknown scope stays free text', () => {
  const ir = parseQuery('invoice in:trash');
  assert.equal(ir.inTrash, true);
  assert.deepEqual(ir.terms, ['invoice']);
  assert.equal(isEmptyQuery(parseQuery('in:trash')), false);
  assert.deepEqual(parseQuery('in:spam').terms, ['in:spam']);
});

test('filename: attachment-name operator (file: alias)', () => {
  assert.equal(parseQuery('filename:report.pdf').filename, 'report.pdf');
  assert.equal(parseQuery('file:"tax 2025.xlsx"').filename, 'tax 2025.xlsx');
});

test('operators and terms combine; unknown operator stays free text', () => {
  const ir = parseQuery('receipt from:apple is:unread weird:thing', NOW);
  assert.deepEqual(ir.terms, ['receipt', 'weird:thing']);
  assert.equal(ir.from, 'apple');
  assert.equal(ir.unread, true);
});

test('isEmptyQuery: state-only queries are not empty', () => {
  assert.equal(isEmptyQuery(parseQuery('is:unread')), false);
  assert.equal(isEmptyQuery(parseQuery('filename:x')), false);
  assert.equal(isEmptyQuery(parseQuery('   ')), true);
});

test('parseSize / parseDate reject garbage', () => {
  assert.equal(parseSize('huge'), undefined);
  assert.equal(parseDate('soonish'), undefined);
});
