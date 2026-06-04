/**
 * Schema/migration coverage (Refactoring Phase 5c). Applies the real Drizzle
 * migrations against a throwaway SQLite file and pins the parts Drizzle can't
 * model and so can't typecheck for us: the hand-written FTS5 virtual table and
 * its sync triggers (migration 0003). The triggers are load-bearing — local
 * search reads `messages_fts`, never a LIKE-scan (ARCHITECTURE §12) — and a
 * silently-dropped trigger would leave search returning stale or missing rows
 * with no compile-time signal. These assert the index tracks INSERT / UPDATE /
 * DELETE on `messages`, and that the FTS MATCH path actually finds a row.
 *
 * `client.ts` opens the DB at import from `env.dbPath`, so we point
 * MAILY_DATA_DIR at a temp dir BEFORE the dynamic import, mirroring store.test.ts.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import type Database from 'better-sqlite3';

// Must be set before the db client (transitively, env.ts) is imported.
const tmpRoot = mkdtempSync(join(tmpdir(), 'maily-migrate-test-'));
process.env.MAILY_DATA_DIR = tmpRoot;

let sqlite: Database.Database;

before(async () => {
  const client = await import('./client.js');
  const { runMigrations } = await import('./migrate.js');
  runMigrations();
  sqlite = client.sqlite;
});

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Insert the minimum `accounts` + `folders` rows a message row's FKs need. */
function seedAccount(): { accountId: string; folderId: string } {
  const accountId = randomUUID();
  const folderId = randomUUID();
  sqlite
    .prepare(
      `INSERT INTO accounts (id, email, provider, imap_host, smtp_host)
       VALUES (?, ?, 'imap', 'imap.example.com', 'smtp.example.com')`,
    )
    .run(accountId, `${accountId}@example.com`);
  sqlite
    .prepare(`INSERT INTO folders (id, account_id, path, name, role) VALUES (?, ?, ?, ?, 'inbox')`)
    .run(folderId, accountId, `inbox-${folderId}`, 'inbox');
  return { accountId, folderId };
}

/** Insert a bare message row; returns its id. Only the FTS-relevant fields vary. */
function insertMessage(
  accountId: string,
  fields: { subject?: string; fromName?: string; fromAddress?: string; bodyText?: string } = {},
): string {
  const id = randomUUID();
  sqlite
    .prepare(
      `INSERT INTO messages (id, account_id, subject, from_name, from_address, body_text, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      accountId,
      fields.subject ?? 'Subject',
      fields.fromName ?? 'Sender',
      fields.fromAddress ?? 'sender@example.com',
      fields.bodyText ?? 'body',
      Date.now(),
    );
  return id;
}

/** The FTS row(s) for a given message id (subject/body as indexed). */
function ftsRowsFor(id: string): { subject: string; body: string }[] {
  return sqlite.prepare(`SELECT subject, body FROM messages_fts WHERE message_id = ?`).all(id) as {
    subject: string;
    body: string;
  }[];
}

// ---------------------------------------------------------------------------
// Schema objects exist after migrating
// ---------------------------------------------------------------------------

test('migrations create the messages_fts virtual table and its three sync triggers', () => {
  const fts = sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'`)
    .get();
  assert.ok(fts, 'messages_fts virtual table exists');

  const triggers = sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name`)
    .all()
    .map((r) => (r as { name: string }).name);
  for (const t of ['messages_fts_ai', 'messages_fts_ad', 'messages_fts_au']) {
    assert.ok(triggers.includes(t), `trigger ${t} exists`);
  }
});

// ---------------------------------------------------------------------------
// Trigger behaviour: the index tracks the table
// ---------------------------------------------------------------------------

test('AFTER INSERT trigger mirrors a new message into the FTS index', () => {
  const { accountId } = seedAccount();
  const id = insertMessage(accountId, { subject: 'Quarterly report', bodyText: 'revenue figures' });

  const rows = ftsRowsFor(id);
  assert.equal(rows.length, 1, 'exactly one FTS row for the message');
  assert.equal(rows[0]!.subject, 'Quarterly report');
  assert.equal(rows[0]!.body, 'revenue figures');
});

test('a MATCH query finds the indexed message by a body token', () => {
  const { accountId } = seedAccount();
  const id = insertMessage(accountId, { bodyText: 'pangolin invoice attached' });

  const hit = sqlite
    .prepare(`SELECT message_id FROM messages_fts WHERE messages_fts MATCH ?`)
    .get('pangolin') as { message_id: string } | undefined;
  assert.equal(hit?.message_id, id);
});

test('AFTER UPDATE trigger re-indexes the new content and drops the old', () => {
  const { accountId } = seedAccount();
  const id = insertMessage(accountId, { bodyText: 'aardvark' });

  sqlite.prepare(`UPDATE messages SET body_text = ? WHERE id = ?`).run('zebra', id);

  const rows = ftsRowsFor(id);
  assert.equal(rows.length, 1, 'still exactly one FTS row (old deleted, new inserted)');
  assert.equal(rows[0]!.body, 'zebra');

  const oldHit = sqlite
    .prepare(`SELECT message_id FROM messages_fts WHERE messages_fts MATCH ?`)
    .get('aardvark');
  assert.equal(oldHit, undefined, 'the pre-update token no longer matches');
});

test('AFTER DELETE trigger removes the message from the FTS index', () => {
  const { accountId } = seedAccount();
  const id = insertMessage(accountId, { bodyText: 'ephemeral' });
  assert.equal(ftsRowsFor(id).length, 1);

  sqlite.prepare(`DELETE FROM messages WHERE id = ?`).run(id);
  assert.equal(ftsRowsFor(id).length, 0, 'FTS row dropped with the message');
});

test('the INSERT trigger falls back to the snippet when body_text is NULL', () => {
  const { accountId } = seedAccount();
  const id = randomUUID();
  sqlite
    .prepare(
      `INSERT INTO messages (id, account_id, subject, snippet, received_at)
       VALUES (?, ?, 'No body', 'snippet stand-in', ?)`,
    )
    .run(id, accountId, Date.now());

  const rows = ftsRowsFor(id);
  assert.equal(rows.length, 1);
  assert.equal(
    rows[0]!.body,
    'snippet stand-in',
    'coalesce(body_text, snippet, "") picks the snippet',
  );
});
