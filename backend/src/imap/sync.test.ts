/**
 * Characterization net for the sync engine's pure transform (Refactoring Phase 1).
 * `buildParsedMessage` maps a captured IMAP message (envelope + BODYSTRUCTURE + flags)
 * into the provider-agnostic `ParsedMessage` the store persists. It is the riskiest
 * *parse* logic in `sync.ts` and — unlike the fetch/download/sweep orchestration around
 * it — is deterministic and needs no live connection, so it's pinned here.
 *
 * The fetch/download deadlock ordering, byte-budget stops, and sweep watermark logic are
 * I/O orchestration; their characterization is the Phase-5 item "feed `.eml` fixtures
 * through the live + sweep paths" (needs a mock ImapFlow harness) and is out of scope here.
 *
 * These tests describe today's behaviour, not an ideal — a regression tripwire.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Capabilities } from './connection.js';
import { buildParsedMessage, type CapturedMessage } from './message-shape.js';

/** The capabilities buildParsedMessage reads (only `gmail` matters here). */
function capsWith(gmail: boolean): Capabilities {
  return { qresync: false, condstore: false, gmail };
}

/** Build a CapturedMessage; envelope/bodyStructure are cast — only their read fields matter. */
function captured(overrides: Partial<CapturedMessage> = {}): CapturedMessage {
  return {
    uid: 1,
    envelope: {
      from: [{ name: 'Alice', address: 'alice@example.com' }],
      to: [
        { name: 'Bob', address: 'bob@example.com' },
        { name: '', address: 'carol@example.com' },
      ],
      cc: [{ name: 'Dave', address: 'dave@example.com' }],
      subject: 'Hello',
      messageId: '<m1@example.com>',
      inReplyTo: '<parent@example.com>',
      date: new Date('2025-06-01T12:00:00Z'),
    } as unknown as CapturedMessage['envelope'],
    bodyStructure: { type: 'text/plain', part: '1' } as unknown as CapturedMessage['bodyStructure'],
    internalDate: new Date('2025-06-01T12:00:05Z'),
    flags: new Set<string>(['\\Seen']),
    headers: Buffer.from('References: <root@example.com> <parent@example.com>\r\n'),
    emailId: 'gm-msg-1',
    threadId: 'gm-thr-1',
    ...overrides,
  };
}

const body = { bodyText: 'plain body', bodyHtml: '<p>html</p>', bodyCalendar: null };

test('non-Gmail: gm_msgid and providerThreadId are NULL even when the fetch carried them', () => {
  const parsed = buildParsedMessage(capsWith(false), captured(), body, null);
  assert.equal(parsed.gmMsgId, null);
  assert.equal(parsed.providerThreadId, null);
  assert.equal(parsed.messageId, '<m1@example.com>');
  assert.equal(parsed.inReplyTo, '<parent@example.com>');
});

test('Gmail: emailId → gm_msgid and threadId → providerThreadId are carried through', () => {
  const parsed = buildParsedMessage(capsWith(true), captured(), body, null);
  assert.equal(parsed.gmMsgId, 'gm-msg-1');
  assert.equal(parsed.providerThreadId, 'gm-thr-1');
});

test('envelope addresses: name-less entries carry null, address-less entries are dropped', () => {
  const msg = captured({
    envelope: {
      from: [{ name: 'Alice', address: 'alice@example.com' }],
      to: [
        { name: 'Bob', address: 'bob@example.com' },
        { name: '', address: 'carol@example.com' },
        { name: 'No Address', address: '' }, // dropped — no usable address
      ],
      cc: [],
    } as unknown as CapturedMessage['envelope'],
  });
  const parsed = buildParsedMessage(capsWith(false), msg, body, null);
  assert.deepEqual(parsed.to, [
    { name: 'Bob', address: 'bob@example.com' },
    { name: null, address: 'carol@example.com' },
  ]);
  assert.deepEqual(parsed.cc, []);
  assert.equal(parsed.fromName, 'Alice');
  assert.equal(parsed.fromAddress, 'alice@example.com');
});

test('References header is read from the raw header bytes; sentAt/receivedAt map across', () => {
  const parsed = buildParsedMessage(capsWith(false), captured(), body, null);
  assert.equal(parsed.references, '<root@example.com> <parent@example.com>');
  assert.equal(parsed.sentAt?.toISOString(), '2025-06-01T12:00:00.000Z');
  assert.equal(parsed.receivedAt?.toISOString(), '2025-06-01T12:00:05.000Z');
  assert.equal(parsed.flags.seen, true);
});

test('a string internalDate is coerced to a Date (imapflow can hand back either)', () => {
  const parsed = buildParsedMessage(
    capsWith(false),
    captured({ internalDate: '2025-06-01T12:00:05Z' as unknown as Date }),
    body,
    null,
  );
  assert.ok(parsed.receivedAt instanceof Date);
  assert.equal(parsed.receivedAt?.toISOString(), '2025-06-01T12:00:05.000Z');
});

test('missing envelope/flags degrade to nulls and false flags, not a throw', () => {
  const parsed = buildParsedMessage(
    capsWith(false),
    captured({ envelope: undefined, flags: undefined, headers: undefined }),
    { bodyText: null, bodyHtml: null, bodyCalendar: null },
    null,
  );
  assert.equal(parsed.messageId, null);
  assert.equal(parsed.fromAddress, null);
  assert.deepEqual(parsed.to, []);
  assert.equal(parsed.references, null);
  assert.equal(parsed.snippet, null);
  assert.equal(parsed.flags.seen, false);
});

test('sourcePath passes through unchanged (live capture supplies it, bulk passes null)', () => {
  const parsed = buildParsedMessage(capsWith(false), captured(), body, '/src/a/b/source.eml');
  assert.equal(parsed.sourcePath, '/src/a/b/source.eml');
});
