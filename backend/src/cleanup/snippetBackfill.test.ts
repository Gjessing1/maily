/**
 * Snippet backfill (self-healing inbox previews). Pins three contracts: a stale snippet
 * is rewritten to exactly what makeSnippet produces while clean rows are left alone,
 * across more than one keyset page; the scan yields to the event loop instead of
 * holding it for the whole pass; and a boot skips the rescan when the snippet code's
 * fingerprint matches the last converged pass.
 *
 * Same bootstrap as sourceBytesBackfill.test.ts: point MAILY_DATA_DIR at a throwaway dir
 * BEFORE the dynamic import so the shared db/env pick it up, then run migrations.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before, beforeEach } from 'node:test';
import { eq } from 'drizzle-orm';
import type * as SchemaNS from '../db/schema.js';
import type * as DbClientNS from '../db/client.js';
import type * as SettingsNS from '../db/settings.js';
import type * as BackfillNS from './snippetBackfill.js';
import type * as ParseNS from '../imap/parse.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'maily-snippet-test-'));
process.env.MAILY_DATA_DIR = tmpRoot;

let db: (typeof DbClientNS)['db'];
let schema: typeof SchemaNS;
let backfill: typeof BackfillNS;
let settings: typeof SettingsNS;
let makeSnippet: (typeof ParseNS)['makeSnippet'];

before(async () => {
  const client = await import('../db/client.js');
  const { runMigrations } = await import('../db/migrate.js');
  runMigrations();
  db = client.db;
  schema = await import('../db/schema.js');
  settings = await import('../db/settings.js');
  backfill = await import('./snippetBackfill.js');
  ({ makeSnippet } = await import('../imap/parse.js'));
});

after(() => rmSync(tmpRoot, { recursive: true, force: true }));

let accountId: string;
beforeEach(() => {
  db.delete(schema.messages).run();
  db.delete(schema.accounts).run();
  db.delete(schema.appSettings).run();
  accountId = randomUUID();
  db.insert(schema.accounts)
    .values({
      id: accountId,
      email: 'me@me.example',
      provider: 'imap',
      imapHost: 'i',
      smtpHost: 's',
    })
    .run();
});

const HTML = '<div style="display:none">hidden preheader</div><p>Visible &amp; clean</p>';

function seed(snippet: string | null): string {
  const id = randomUUID();
  db.insert(schema.messages)
    .values({
      id,
      accountId,
      fromAddress: 'a@b.example',
      receivedAt: new Date(),
      subject: 'Hello',
      bodyHtml: HTML,
      snippet,
    })
    .run();
  return id;
}

function snippetOf(id: string): string | null {
  return (
    db
      .select({ snippet: schema.messages.snippet })
      .from(schema.messages)
      .where(eq(schema.messages.id, id))
      .get()?.snippet ?? null
  );
}

test('rewrites stale snippets across pages and leaves clean ones alone', async () => {
  const clean = makeSnippet(null, HTML, 'Hello');
  assert.ok(clean && !clean.includes('hidden'));
  const cleanIds = Array.from({ length: 450 }, () => seed(clean));
  const staleIds = [seed('hidden preheader Visible &amp; clean'), seed('<html lang="en">')];

  const result = await backfill.backfillSnippets();

  assert.deepEqual(result, { scanned: 452, fixed: 2, deferred: 0 });
  for (const id of staleIds) assert.equal(snippetOf(id), clean);
  assert.equal(snippetOf(cleanIds[449]!), clean);
});

test('yields to the event loop while scanning', async () => {
  for (let i = 0; i < 20; i++) seed('stale');
  let ticks = 0;
  const timer = setInterval(() => ticks++, 0);
  try {
    await backfill.backfillSnippets(Number.POSITIVE_INFINITY, 0);
  } finally {
    clearInterval(timer);
  }
  assert.ok(ticks > 0, 'a timer callback ran while the scan was in progress');
});

test('drain skips the rescan while the snippet fingerprint is unchanged', async () => {
  const id = seed('stale');
  await backfill.drainSnippets();
  const clean = makeSnippet(null, HTML, 'Hello');
  assert.equal(snippetOf(id), clean);
  assert.deepEqual(settings.getSetting('snippet.backfill', {}), {
    fingerprint: backfill.snippetFingerprint(),
  });

  // Same code → no scan, so a row corrupted behind its back stays as it is.
  db.update(schema.messages)
    .set({ snippet: 'stale again' })
    .where(eq(schema.messages.id, id))
    .run();
  await backfill.drainSnippets();
  assert.equal(snippetOf(id), 'stale again');

  // Changed code (a different stored fingerprint) re-arms the full rescan.
  settings.putSetting('snippet.backfill', { fingerprint: 'older-parse-module' });
  await backfill.drainSnippets();
  assert.equal(snippetOf(id), clean);
});
