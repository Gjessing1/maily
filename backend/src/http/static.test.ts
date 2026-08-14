import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAppShellCsp } from './static.js';

test('app-shell CSP permits consented remote message media but permanently blocks remote fonts', () => {
  const csp = buildAppShellCsp('<script>bootstrap()</script>');
  assert.match(csp, /img-src[^;]*https:/);
  assert.match(csp, /media-src[^;]*https:/);
  assert.match(csp, /font-src 'self' data:/);
  assert.doesNotMatch(csp, /font-src[^;]*https?:/);
  assert.match(csp, /script-src 'self' 'sha256-/);
});
