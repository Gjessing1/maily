import assert from 'node:assert/strict';
import test from 'node:test';
import { uploadAttachmentOptions } from './compose.js';

test('a dropped composer image becomes an inline CID MIME part', () => {
  const options = uploadAttachmentOptions(
    {
      uploadId: 'ignored-here',
      filename: 'photo.png',
      mimeType: 'image/png',
      isInline: true,
      contentId: 'photo@inline',
    },
    '/staged/photo',
  );
  assert.equal(options.path, '/staged/photo');
  assert.equal(options.cid, 'photo@inline');
  assert.equal(options.contentDisposition, 'inline');
});

test('a paperclip upload remains a regular attachment', () => {
  const options = uploadAttachmentOptions(
    { uploadId: 'ignored-here', filename: 'notes.txt', mimeType: 'text/plain' },
    '/staged/notes',
  );
  assert.equal(options.cid, undefined);
  assert.equal(options.contentDisposition, undefined);
});
