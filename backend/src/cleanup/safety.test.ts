/**
 * Cleanup safety filter coverage (ROADMAP Phase 6 HARD safety rules). Pins the bilingual
 * (EN + NO) protected-keyword detection — the gate that keeps financial / legal /
 * account-security / medical mail out of every delete-eligible slice. Pure (no DB).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { isProtected, PROTECTED_MATCH } from './safety.js';

test('isProtected: English protected keywords trigger', () => {
  assert.ok(isProtected({ subject: 'Your invoice is ready' }));
  assert.ok(isProtected({ body: 'Reset your password here' }));
  assert.ok(isProtected({ subject: 'Tax statement 2025' }));
  assert.ok(isProtected({ from: 'security@bank.example' }));
});

test('isProtected: Norwegian protected keywords trigger', () => {
  assert.ok(isProtected({ subject: 'Din faktura er klar' }));
  assert.ok(isProtected({ body: 'Tilbakestill passordet ditt' }));
  assert.ok(isProtected({ subject: 'Skattemelding 2025' })); // prefix-match: skatt*
});

test('isProtected: diacritics are folded (vilkår matches vilkar)', () => {
  assert.ok(isProtected({ subject: 'Nye vilkår' }));
  assert.ok(isProtected({ subject: 'Nye vilkar' }));
});

test('isProtected: ordinary mail is not protected', () => {
  assert.equal(isProtected({ subject: 'Weekly newsletter', body: 'big sale today' }), false);
  assert.equal(isProtected({ subject: 'Lunch tomorrow?' }), false);
  assert.equal(isProtected({}), false);
});

test('PROTECTED_MATCH is a non-empty OR-joined prefix FTS expression', () => {
  assert.match(PROTECTED_MATCH, /"invoice"\*/);
  assert.match(PROTECTED_MATCH, / OR /);
});
