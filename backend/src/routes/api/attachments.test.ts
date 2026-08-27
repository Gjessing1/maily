/**
 * An attachment is a stranger's file served from maily's own origin, so what the
 * `Content-Disposition` says decides whether the browser renders it *as* maily or hands
 * it to the disk. Serving `inline` is the point — the desktop "open" path navigates
 * straight at this route instead of pulling megabytes into a blob (frontend
 * `ui/openAttachment.ts`) — which is exactly why the scriptable families must not slip
 * through it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { contentDisposition } from './attachments.js';

test('scriptable attachments download, everything else renders in a tab', () => {
  for (const type of [
    'text/html',
    'text/html; charset=utf-8',
    'TEXT/HTML',
    'image/svg+xml',
    'text/xml',
    // The same thing as text/xml, and the reason this matches by family.
    'application/xml',
    'application/xhtml+xml',
  ]) {
    assert.equal(
      contentDisposition(type, 'note.html'),
      'attachment; filename="note.html"',
      `${type} must never render as maily`,
    );
  }

  for (const type of ['application/pdf', 'image/png', 'text/plain', 'application/octet-stream']) {
    assert.equal(contentDisposition(type, 'invoice.pdf'), 'inline; filename="invoice.pdf"');
  }
});

test('the sender names the file, so the name is quoted rather than trusted', () => {
  assert.equal(
    contentDisposition('application/pdf', 'in"voice".pdf'),
    'inline; filename="invoice.pdf"',
  );
  // A sender who attached a file without naming it gets a bare disposition, not `""`.
  assert.equal(contentDisposition('application/pdf', null), 'inline');
});
