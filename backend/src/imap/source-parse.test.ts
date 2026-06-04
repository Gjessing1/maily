/**
 * Rebuild parse path (ROADMAP §3.7.E). `parseSourceContent` is the authoritative
 * derivation of a message's content columns from its canonical `.eml` — the offline
 * rebuild rewrites exactly these fields, so this asserts the header/body/snippet
 * mapping that feeds both the parsed row and (via the FTS trigger) the search index.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseSourceContent } from './source-parse.js';

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

    // bodyText is kept verbatim (mailparser leaves a trailing newline, as on the live
    // path); the snippet is the whitespace-collapsed preview.
    assert.equal(c.bodyText?.trim(), 'Plain body text here.');
    assert.match(c.bodyHtml ?? '', /HTML body here\./);
    assert.equal(c.snippet, 'Plain body text here.');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
