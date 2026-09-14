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

test('migrations create the FTS index and trigger-maintained cleanup version', () => {
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
  for (const t of [
    'cleanup_version_messages_ai',
    'cleanup_version_messages_ad',
    'cleanup_version_messages_au',
    'cleanup_version_attachments_ai',
    'cleanup_version_queue_au',
    'cleanup_version_settings_au',
  ]) {
    assert.ok(triggers.includes(t), `trigger ${t} exists`);
  }

  assert.deepEqual(sqlite.prepare(`SELECT scope, version FROM data_versions`).get(), {
    scope: 'cleanup',
    version: 0,
  });
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

test('cleanup version tracks relevant writes and ignores unrelated message columns', () => {
  const { accountId } = seedAccount();
  const version = (): number =>
    (
      sqlite.prepare(`SELECT version FROM data_versions WHERE scope = 'cleanup'`).get() as {
        version: number;
      }
    ).version;

  const before = version();
  const messageId = insertMessage(accountId);
  assert.equal(version(), before + 1, 'message insert');

  sqlite
    .prepare(`UPDATE messages SET seen = 1, flagged = 1, source_path = ? WHERE id = ?`)
    .run('/tmp/source.eml', messageId);
  assert.equal(version(), before + 1, 'flags and source path are outside cleanup analytics');

  sqlite.prepare(`UPDATE messages SET source_bytes = 1234 WHERE id = ?`).run(messageId);
  assert.equal(version(), before + 2, 'source byte total');

  const attachmentId = randomUUID();
  sqlite
    .prepare(`INSERT INTO attachments (id, message_id, size_bytes) VALUES (?, ?, 100)`)
    .run(attachmentId, messageId);
  assert.equal(version(), before + 3, 'attachment insert');

  sqlite
    .prepare(`UPDATE attachments SET storage_path = ? WHERE id = ?`)
    .run('/tmp/a', attachmentId);
  assert.equal(version(), before + 3, 'download location does not affect cleanup analytics');

  sqlite.prepare(`UPDATE attachments SET size_bytes = 200 WHERE id = ?`).run(attachmentId);
  assert.equal(version(), before + 4, 'attachment size');

  sqlite.prepare(`INSERT INTO app_settings (key, value) VALUES ('prefs', '{}')`).run();
  assert.equal(version(), before + 5, 'cleanup keyword settings');

  const queueId = randomUUID();
  sqlite
    .prepare(
      `INSERT INTO cleanup_queue (id, message_id, account_id, slice)
       VALUES (?, ?, ?, 'newsletters')`,
    )
    .run(queueId, messageId, accountId);
  assert.equal(version(), before + 6, 'cleanup queue insert');

  sqlite.prepare(`UPDATE cleanup_queue SET status = 'done' WHERE id = ?`).run(queueId);
  assert.equal(version(), before + 7, 'cleanup completion tally');
});

/**
 * `push_devices` (migration 0028) is the Android APK's push registration — the only
 * channel that can wake it, since System WebView exposes no Push API. The row holds a
 * *hash* of the bearer secret the APK's foreground service presents on the push stream,
 * and re-presenting the same secret is an upsert, so the unique index is what stops a
 * device that re-registers on every app boot from accumulating a row per launch.
 *
 * The 0027 `device_tokens` table it replaces must be gone: it held Google-minted FCM
 * tokens, worthless to a transport that never contacts Google.
 */
test('push_devices keys on the token hash so re-registration upserts', () => {
  const gone = sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'device_tokens'`)
    .all();
  assert.deepEqual(gone, [], 'the FCM device_tokens table is dropped by 0028');

  const insert = sqlite.prepare(
    `INSERT INTO push_devices (id, token_hash, platform, last_seen_at) VALUES (?, ?, 'android', ?)
     ON CONFLICT(token_hash) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  );
  insert.run(randomUUID(), 'hash-abc', 1000);
  insert.run(randomUUID(), 'hash-abc', 2000);
  insert.run(randomUUID(), 'hash-xyz', 3000);

  const rows = sqlite
    .prepare(`SELECT token_hash, last_seen_at FROM push_devices ORDER BY token_hash`)
    .all() as { token_hash: string; last_seen_at: number }[];
  assert.deepEqual(
    rows.map((r) => r.token_hash),
    ['hash-abc', 'hash-xyz'],
  );
  // The re-registration refreshed the row rather than adding one.
  assert.equal(rows[0]!.last_seen_at, 2000);
});
