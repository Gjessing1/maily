/**
 * Cleanup safety filter coverage (ROADMAP Phase 6 HARD safety rules). Pins the bilingual
 * (EN + NO) protected-keyword detection — the gate that keeps financial / legal /
 * account-security / medical mail out of every delete-eligible slice — plus the user's
 * custom protected-keyword extension.
 *
 * The protected match now reads the synced prefs blob for custom additions, so this bootstraps
 * an isolated temp DB (migrations create app_settings) before the dynamic import, like
 * slices.test.ts — pointing MAILY_DATA_DIR at a throwaway dir first.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before, beforeEach } from 'node:test';
import type * as SettingsNS from '../db/settings.js';
import type * as SafetyNS from './safety.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'maily-safety-test-'));
process.env.MAILY_DATA_DIR = tmpRoot;

let settings: typeof SettingsNS;
let Safety: typeof SafetyNS;

before(async () => {
  const { runMigrations } = await import('../db/migrate.js');
  runMigrations();
  settings = await import('../db/settings.js');
  Safety = await import('./safety.js');
});

after(() => rmSync(tmpRoot, { recursive: true, force: true }));

beforeEach(() => settings.putPrefs({}));

test('isProtected: English protected keywords trigger', () => {
  assert.ok(Safety.isProtected({ subject: 'Your invoice is ready' }));
  assert.ok(Safety.isProtected({ body: 'Reset your password here' }));
  assert.ok(Safety.isProtected({ subject: 'Tax statement 2025' }));
  assert.ok(Safety.isProtected({ from: 'security@bank.example' }));
});

test('isProtected: Norwegian protected keywords trigger', () => {
  assert.ok(Safety.isProtected({ subject: 'Din faktura er klar' }));
  assert.ok(Safety.isProtected({ body: 'Tilbakestill passordet ditt' }));
  assert.ok(Safety.isProtected({ subject: 'Skattemelding 2025' })); // prefix-match: skatt*
});

test('isProtected: diacritics are folded (vilkår matches vilkar)', () => {
  assert.ok(Safety.isProtected({ subject: 'Nye vilkår' }));
  assert.ok(Safety.isProtected({ subject: 'Nye vilkar' }));
});

test('isProtected: ordinary mail is not protected', () => {
  assert.equal(Safety.isProtected({ subject: 'Weekly newsletter', body: 'big sale today' }), false);
  assert.equal(Safety.isProtected({ subject: 'Lunch tomorrow?' }), false);
  assert.equal(Safety.isProtected({}), false);
});

test('protectedMatch is a non-empty OR-joined prefix FTS expression', () => {
  assert.match(Safety.protectedMatch(), /"invoice"\*/);
  assert.match(Safety.protectedMatch(), / OR /);
});

test('custom protected keywords extend the gate (FTS expr + isProtected)', () => {
  settings.putPrefs({ cleanupProtectedKeywords: ['warranty', 'garanti'] });
  assert.match(Safety.protectedMatch(), /"warranty"\*/);
  assert.ok(Safety.isProtected({ subject: 'Your warranty certificate' }));
  assert.ok(Safety.isProtected({ subject: 'Din garanti er gyldig' }));
  // A built-in still applies alongside the additions.
  assert.ok(Safety.isProtected({ subject: 'Your invoice' }));
});
