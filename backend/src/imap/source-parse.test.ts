/**
 * Rebuild parse path (ROADMAP §3.7.E). `parseSourceContent` is the authoritative
 * derivation of a message's content columns from its canonical `.eml` — the offline
 * rebuild rewrites exactly these fields, so this asserts the header/body/snippet
 * mapping that feeds both the parsed row and (via the FTS trigger) the search index.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MessageStructureObject } from 'imapflow';
import test from 'node:test';
import { materializeMimeBody } from './body-resolver.js';
import { extractStructure } from './parse.js';
import { deriveBodyFromSource, parseSourceContent } from './source-parse.js';

const CRLF = '\r\n';

/** A multipart/alternative message with a named From, two To, one Cc, and threading headers. */
const EML = [
  'From: Alice Example <alice@example.com>',
  'To: Bob <bob@example.com>, carol@example.com',
  'Cc: Dave <dave@example.com>',
  'Subject: Quarterly report',
  'Message-ID: <msg-1@example.com>',
  'In-Reply-To: <parent@example.com>',
  'References: <root@example.com> <parent@example.com>',
  'Date: Tue, 03 Jun 2025 10:15:00 +0000',
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative; boundary="ALT"',
  '',
  '--ALT',
  'Content-Type: text/plain; charset="utf-8"',
  '',
  'Plain body text here.',
  '',
  '--ALT',
  'Content-Type: text/html; charset="utf-8"',
  '',
  '<p>HTML body here.</p>',
  '',
  '--ALT--',
  '',
].join(CRLF);

test('§3.7.E: parseSourceContent derives content columns from the raw .eml', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maily-rebuild-'));
  try {
    const path = join(dir, 'source.eml');
    await writeFile(path, EML);

    const c = await parseSourceContent(path);

    assert.equal(c.subject, 'Quarterly report');
    assert.equal(c.fromName, 'Alice Example');
    assert.equal(c.fromAddress, 'alice@example.com');

    // To/Cc flatten to EmailAddress[]; a name-less address carries null, not ''.
    assert.deepEqual(c.to, [
      { name: 'Bob', address: 'bob@example.com' },
      { name: null, address: 'carol@example.com' },
    ]);
    assert.deepEqual(c.cc, [{ name: 'Dave', address: 'dave@example.com' }]);

    assert.equal(c.inReplyTo, '<parent@example.com>');
    // References normalise to a single space-separated string (matches the stored header).
    assert.equal(c.references, '<root@example.com> <parent@example.com>');
    assert.equal(c.sentAt?.toISOString(), '2025-06-03T10:15:00.000Z');

    // The selected HTML alternative is what the reader renders, while bodyText keeps
    // the clean fallback. The snippet therefore follows visible HTML text.
    assert.equal(c.bodyText?.trim(), 'Plain body text here.');
    assert.match(c.bodyHtml ?? '', /HTML body here\./);
    assert.equal(c.snippet, 'HTML body here.');
    // No text/calendar part in this message → bodyCalendar stays null.
    assert.equal(c.bodyCalendar, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A calendar invite: text/plain + an inline text/calendar; method=REQUEST part. */
const INVITE_EML = [
  'From: Organizer <org@example.com>',
  'To: me@example.com',
  'Subject: Invitation: Team Sync',
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative; boundary="ALT"',
  '',
  '--ALT',
  'Content-Type: text/plain; charset="utf-8"',
  '',
  'You are invited.',
  '',
  '--ALT',
  'Content-Type: text/calendar; method=REQUEST; charset="utf-8"',
  '',
  'BEGIN:VCALENDAR',
  'METHOD:REQUEST',
  'BEGIN:VEVENT',
  'UID:evt-1@example.com',
  'SUMMARY:Team Sync',
  'DTSTART:20260610T090000Z',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
  '--ALT--',
  '',
].join(CRLF);

test('§3.7.E: parseSourceContent captures an inline text/calendar part as bodyCalendar', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maily-rebuild-ics-'));
  try {
    const path = join(dir, 'source.eml');
    await writeFile(path, INVITE_EML);

    const c = await parseSourceContent(path);

    assert.match(c.bodyCalendar ?? '', /BEGIN:VEVENT/);
    assert.match(c.bodyCalendar ?? '', /SUMMARY:Team Sync/);
    // The display body is still the human text part, not the iCalendar block.
    assert.equal(c.bodyText?.trim(), 'You are invited.');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Gmail rendering: live, bulk and rebuild agree on adversarial MIME selection', async () => {
  const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/gmail-rendering.eml');
  const structure = {
    type: 'multipart/mixed',
    childNodes: [
      {
        type: 'multipart/alternative',
        childNodes: [
          { type: 'text/plain', part: '1.1' },
          {
            type: 'multipart/related',
            parameters: { start: '<root@example.com>' },
            childNodes: [
              {
                type: 'image/png',
                part: '1.2.1',
                disposition: 'inline',
                id: '<logo@example.com>',
              },
              {
                type: 'multipart/alternative',
                id: '<root@example.com>',
                childNodes: [
                  { type: 'text/plain', part: '1.2.2.1' },
                  { type: 'text/html', part: '1.2.2.2' },
                  { type: 'text/html', part: '1.2.2.3' },
                ],
              },
            ],
          },
        ],
      },
      {
        type: 'message/rfc822',
        part: '2',
        disposition: 'attachment',
        dispositionParameters: { filename: 'forwarded.eml' },
        childNodes: [{ type: 'text/html', part: '2.1' }],
      },
    ],
  } as unknown as MessageStructureObject;

  const selected = extractStructure(structure);
  assert.deepEqual(selected.displayParts, [{ kind: 'html', partId: '1.2.2.3' }]);
  assert.equal(selected.textPartId, '1.2.2.1');

  const values = new Map([
    ['1.2.2.1', 'Nested readable fallback.\r\n'],
    [
      '1.2.2.3',
      '<div style="display:none">Hidden preview trap</div><p>Visible HTML winner.</p><img src="cid:logo@example.com" alt="Brand logo">\r\n',
    ],
  ]);
  const bulk = materializeMimeBody({
    display: selected.displayParts.map((part) => ({
      kind: part.kind,
      value: values.get(part.partId)!,
    })),
    plainFallback: values.get(selected.textPartId!)!,
    calendar: null,
  });
  const live = await deriveBodyFromSource(fixture);
  const rebuild = await parseSourceContent(fixture);

  assert.equal(live.bodyText?.trim(), bulk.bodyText?.trim());
  assert.equal(live.bodyHtml?.trim(), bulk.bodyHtml?.trim());
  assert.equal(rebuild.bodyText?.trim(), live.bodyText?.trim());
  assert.equal(rebuild.bodyHtml?.trim(), live.bodyHtml?.trim());
  assert.equal(rebuild.snippet, 'Visible HTML winner. Brand logo');
  assert.doesNotMatch(rebuild.bodyHtml ?? '', /Forwarded body/);
});
