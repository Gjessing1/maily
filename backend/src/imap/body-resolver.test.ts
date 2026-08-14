import assert from 'node:assert/strict';
import test from 'node:test';
import { materializeMimeBody, resolveMimeBody, type MimeBodyNode } from './body-resolver.js';

const leaf = (type: string, value: string): MimeBodyNode<string> => ({ type, value });

test('multipart/alternative chooses the last supported child even when plain follows HTML', () => {
  const result = resolveMimeBody({
    type: 'multipart/alternative',
    children: [leaf('text/html', '<p>earlier html</p>'), leaf('text/plain', 'later plain')],
  });
  assert.deepEqual(result.display, [{ kind: 'plain', value: 'later plain' }]);
  assert.deepEqual(materializeMimeBody(result), {
    bodyText: 'later plain',
    bodyHtml: null,
    bodyCalendar: null,
  });
});

test('nested alternatives retain plaintext fallback for the selected HTML branch', () => {
  const result = resolveMimeBody({
    type: 'multipart/alternative',
    children: [
      leaf('text/plain', 'fallback'),
      {
        type: 'multipart/alternative',
        children: [leaf('text/plain', 'nested fallback'), leaf('text/html', '<b>winner</b>')],
      },
    ],
  });
  assert.deepEqual(result.display, [{ kind: 'html', value: '<b>winner</b>' }]);
  assert.equal(result.plainFallback, 'nested fallback');
});

test('multipart/related renders its declared root and ignores inline resources', () => {
  const result = resolveMimeBody({
    type: 'multipart/related',
    relatedStart: '<root@x>',
    children: [
      { type: 'image/png', contentId: 'logo@x', value: 'bytes' },
      { type: 'text/html', contentId: 'root@x', value: '<p>root</p>' },
    ],
  });
  assert.deepEqual(result.display, [{ kind: 'html', value: '<p>root</p>' }]);
});

test('multipart/mixed preserves independent bodies and excludes forwarded message bodies', () => {
  const result = resolveMimeBody({
    type: 'multipart/mixed',
    children: [
      leaf('text/plain', 'first'),
      { type: 'message/rfc822', children: [leaf('text/html', '<p>forwarded</p>')] },
      leaf('text/html', '<p>second</p>'),
    ],
  });
  assert.deepEqual(result.display, [
    { kind: 'plain', value: 'first' },
    { kind: 'html', value: '<p>second</p>' },
  ]);
  const body = materializeMimeBody(result);
  assert.match(body.bodyHtml ?? '', /first/);
  assert.match(body.bodyHtml ?? '', /second/);
  assert.doesNotMatch(body.bodyHtml ?? '', /forwarded/);
});
