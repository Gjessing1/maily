/**
 * Ordinal tripwire (ROADMAP §3.7.E). The local-source attachment resolver matches a
 * CID-less attachment by its document-order `part_ordinal`, which is correct ONLY if
 * the raw-`.eml` walk (`enumerateSourceParts`) and the IMAP BODYSTRUCTURE walk
 * (`extractStructure`) enumerate the *same* parts in the *same* order. Both are meant
 * to run the one shared classifier (`classifyPart`); if a future edit moves the
 * predicate on one side only, the two enumerations drift and the wrong bytes get
 * served. This test builds an adversarial MIME tree — duplicate (filename, mime,
 * size) tuples, a null-filename attachment, a nested multipart, and inline-text vs
 * inline-image — and asserts the two enumerations are identical, so a one-sided
 * predicate edit fails the build.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { MessageStructureObject } from 'imapflow';
import { extractStructure } from './parse.js';
import { enumerateSourceParts, extractPartFromSource } from './source-extract.js';

const CRLF = '\r\n';

/**
 * The adversarial message, as raw RFC822. Mirrors `BODYSTRUCTURE` below part-for-part.
 * Selected (attachment) parts, in document order: image/png inline-CID (ordinal 0),
 * two byte-identical application/pdf attachments (ordinals 1, 2), a filename-less
 * application/octet-stream attachment (ordinal 3). The two text bodies and the
 * inline *text* part must be excluded by both walks.
 */
const EML = [
  'From: a@example.com',
  'To: b@example.com',
  'Subject: adversarial',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="MIX"',
  '',
  '--MIX',
  'Content-Type: multipart/alternative; boundary="ALT"',
  '',
  '--ALT',
  'Content-Type: text/plain; charset="utf-8"',
  '',
  'plain body',
  '--ALT',
  'Content-Type: text/html; charset="utf-8"',
  '',
  '<p>html body</p>',
  '--ALT--',
  '',
  '--MIX',
  'Content-Type: image/png',
  'Content-Disposition: inline',
  'Content-ID: <logo@x>',
  'Content-Transfer-Encoding: base64',
  '',
  'iVBORw0KGgo=',
  '--MIX',
  'Content-Type: application/pdf',
  'Content-Disposition: attachment; filename="doc.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  'JVBERi0xLjQK',
  '--MIX',
  'Content-Type: application/pdf',
  'Content-Disposition: attachment; filename="doc.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  'JVBERi0xLjQK',
  '--MIX',
  'Content-Type: application/octet-stream',
  'Content-Disposition: attachment',
  'Content-Transfer-Encoding: base64',
  '',
  'AAECAwQF',
  '--MIX',
  'Content-Type: text/plain; charset="utf-8"',
  'Content-Disposition: inline',
  'Content-ID: <note@x>',
  '',
  'inline text, not an attachment',
  '--MIX--',
  '',
].join(CRLF);

/** Hand-built imapflow BODYSTRUCTURE mirroring EML part-for-part. */
const BODYSTRUCTURE = {
  type: 'multipart/mixed',
  childNodes: [
    {
      type: 'multipart/alternative',
      childNodes: [
        { type: 'text/plain', part: '1.1', size: 10 },
        { type: 'text/html', part: '1.2', size: 16 },
      ],
    },
    { type: 'image/png', part: '2', disposition: 'inline', id: '<logo@x>', size: 8 },
    {
      type: 'application/pdf',
      part: '3',
      disposition: 'attachment',
      dispositionParameters: { filename: 'doc.pdf' },
      size: 9,
    },
    {
      type: 'application/pdf',
      part: '4',
      disposition: 'attachment',
      dispositionParameters: { filename: 'doc.pdf' },
      size: 9,
    },
    { type: 'application/octet-stream', part: '5', disposition: 'attachment', size: 6 },
    { type: 'text/plain', part: '6', disposition: 'inline', id: '<note@x>', size: 30 },
  ],
} as unknown as MessageStructureObject;

test('§3.7.E: raw-.eml and BODYSTRUCTURE walks enumerate identical parts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maily-ordinal-'));
  const path = join(dir, 'source.eml');
  await writeFile(path, EML);
  try {
    const bs = extractStructure(BODYSTRUCTURE).attachments;
    const src = await enumerateSourceParts(path);

    // Both walks select exactly the four attachment parts — the two bodies and the
    // inline *text* part are excluded on both sides.
    assert.equal(src.length, 4, 'raw-.eml walk should select 4 parts');
    assert.equal(bs.length, 4, 'BODYSTRUCTURE walk should select 4 parts');

    for (let i = 0; i < bs.length; i++) {
      // (a) document-order ordinal + content-id enumeration is identical.
      assert.equal(src[i]!.partOrdinal, i, `src ordinal ${i}`);
      assert.equal(bs[i]!.partOrdinal, i, `bs ordinal ${i}`);
      assert.equal(src[i]!.contentId, bs[i]!.contentId, `content-id at ${i}`);
      // (b) the (filename, mime) post-match sanity tuple agrees — never fires for a
      // correct match (size is intentionally not compared: BODYSTRUCTURE size is the
      // encoded octet count, not the decoded on-disk size).
      assert.equal(src[i]!.filename, bs[i]!.filename, `filename at ${i}`);
      assert.equal(src[i]!.mimeType, bs[i]!.mimeType, `mime at ${i}`);
    }

    // Spot-check the adversarial specifics survived: inline image carries its CID,
    // the duplicate-tuple PDFs are distinct ordinals, the octet part has no filename.
    assert.deepEqual(
      src.map((p) => [p.partOrdinal, p.mimeType, p.filename, p.contentId]),
      [
        [0, 'image/png', null, 'logo@x'],
        [1, 'application/pdf', 'doc.pdf', null],
        [2, 'application/pdf', 'doc.pdf', null],
        [3, 'application/octet-stream', null, null],
      ],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('§3.7.E: extractPartFromSource streams the right decoded bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maily-extract-'));
  const path = join(dir, 'source.eml');
  await writeFile(path, EML);
  try {
    // CID-less attachment selected by ordinal: the octet-stream part (base64
    // 'AAECAwQF' → bytes 00..05). Proves ordinal matching + streaming decode.
    const byOrdinal = await extractPartFromSource(
      path,
      { contentId: null, partOrdinal: 3 },
      join(dir, 'out-ordinal.bin'),
    );
    assert.ok(byOrdinal, 'ordinal match should resolve');
    assert.equal(byOrdinal!.mimeType, 'application/octet-stream');
    assert.deepEqual(
      [...(await readFile(join(dir, 'out-ordinal.bin')))],
      [0, 1, 2, 3, 4, 5],
      'decoded octet-stream bytes',
    );

    // Part carrying a Content-ID is matched on the CID, not the ordinal — even when a
    // mismatching ordinal is supplied, the CID wins (the resolver's "content_id first").
    const byCid = await extractPartFromSource(
      path,
      { contentId: 'logo@x', partOrdinal: 99 },
      join(dir, 'out-cid.bin'),
    );
    assert.ok(byCid, 'cid match should resolve');
    assert.equal(byCid!.mimeType, 'image/png');
    assert.deepEqual(
      [...(await readFile(join(dir, 'out-cid.bin')))],
      // base64 'iVBORw0KGgo=' → the 8-byte PNG signature.
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      'decoded png signature',
    );

    // A CID-less target whose ordinal doesn't exist resolves to null, so the resolver
    // falls through to the IMAP path.
    const miss = await extractPartFromSource(
      path,
      { contentId: null, partOrdinal: 99 },
      join(dir, 'out-miss.bin'),
    );
    assert.equal(miss, null, 'no match → null (IMAP fallback)');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
