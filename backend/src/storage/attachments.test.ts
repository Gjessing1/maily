/**
 * Inline-CID embedding guards (ROADMAP §3.7 hardening). `embedInlineImages` rewrites
 * `cid:` references to `data:` URIs, but must bound how much it stuffs into the reader
 * srcdoc: a per-image cap, a per-body cumulative byte budget, and a max-count cap.
 * Images past any limit are left as `cid:` (the caller then surfaces them in the
 * attachments panel). Pointing each row's `storagePath` at a real temp file makes the
 * shared resolver return immediately, so these tests need no IMAP or DB.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AttachmentRow } from '../db/queries.js';
import { embedInlineImages } from './attachments.js';

const dir = mkdtempSync(join(tmpdir(), 'maily-inline-'));

/** A downloaded inline-image attachment whose bytes live in a temp file of `bytes` size. */
function inlineAtt(i: number, bytes: number, declaredSize: number | null = bytes): AttachmentRow {
  const path = join(dir, `att-${i}.bin`);
  writeFileSync(path, Buffer.alloc(bytes, 1));
  return {
    id: `att-${i}`,
    messageId: 'msg-1',
    filename: `img-${i}.png`,
    mimeType: 'image/png',
    sizeBytes: declaredSize,
    imapPartId: null,
    partOrdinal: null,
    contentId: `cid-${i}`,
    isInline: true,
    storagePath: path,
    downloadedAt: new Date(),
    createdAt: new Date(),
  };
}

/** An HTML body referencing every attachment's CID once. */
function bodyFor(atts: AttachmentRow[]): string {
  return atts.map((a) => `<img src="cid:${a.contentId}">`).join('');
}

test('embeds a small inline image as a data: URI', async () => {
  const atts = [inlineAtt(0, 64)];
  const { html, embeddedIds } = await embedInlineImages(bodyFor(atts), atts);
  assert.equal(embeddedIds.size, 1);
  assert.ok(html!.includes('data:image/png;base64,'));
  assert.ok(!html!.includes('cid:cid-0'));
});

test('leaves an over-cap image (by declared size) as cid: for the attachments panel', async () => {
  // Declared size over the 500 KB per-image cap → skipped before reading bytes.
  const atts = [inlineAtt(0, 64, 600 * 1024)];
  const { html, embeddedIds } = await embedInlineImages(bodyFor(atts), atts);
  assert.equal(embeddedIds.size, 0);
  assert.ok(html!.includes('cid:cid-0'));
});

test('caps the number of inline images embedded per body', async () => {
  const atts = Array.from({ length: 25 }, (_, i) => inlineAtt(i, 16));
  const { embeddedIds } = await embedInlineImages(bodyFor(atts), atts);
  assert.equal(embeddedIds.size, 20); // INLINE_EMBED_MAX_COUNT
});

test('caps the cumulative embedded bytes per body', async () => {
  // 400 KB each, under the per-image cap; the 5 MB body budget fits 12 of 15.
  const atts = Array.from({ length: 15 }, (_, i) => inlineAtt(i, 400 * 1024));
  const { embeddedIds } = await embedInlineImages(bodyFor(atts), atts);
  assert.equal(embeddedIds.size, 12);
});
