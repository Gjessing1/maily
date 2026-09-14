/**
 * Migration 0030 moves the settings the server acts on out of the client-owned prefs blob. An
 * existing install must keep the user's cleanup keyword lists and undo-send window, so this
 * applies every migration before 0030, stores a prefs blob the way the old client wrote it, then
 * applies the rest.
 */
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

const MIGRATIONS = new URL('../../drizzle', import.meta.url).pathname;
const tmpRoot = mkdtempSync(join(tmpdir(), 'maily-migrate-0030-test-'));

after(() => rmSync(tmpRoot, { recursive: true, force: true }));

/** A copy of the migrations folder whose journal stops just before `tag`. */
function migrationsBefore(tag: string): string {
  const dir = join(tmpRoot, 'drizzle');
  cpSync(MIGRATIONS, dir, { recursive: true });
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
  const stop = journal.entries.findIndex((e) => e.tag === tag);
  assert.ok(stop > 0, `migration ${tag} is in the journal`);
  journal.entries = journal.entries.slice(0, stop);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

test('0030 moves server settings out of an existing prefs blob', () => {
  const sqlite = new Database(join(tmpRoot, 'mail.sqlite'));
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: migrationsBefore('0030_server_settings') });

  sqlite.prepare(`INSERT INTO app_settings (key, value) VALUES ('prefs', ?)`).run(
    JSON.stringify({
      theme: 'dark',
      readingPaneMinWidth: 768,
      cleanupProtectedKeywords: ['warranty', 'garanti'],
      cleanupColdKeepKeywords: [],
      undoSendSeconds: 0,
    }),
  );
  migrate(db, { migrationsFolder: MIGRATIONS });

  const read = (key: string): unknown =>
    JSON.parse(
      (sqlite.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key) as { value: string })
        .value,
    );
  // The newsletter list was never set, so it stays absent and the server default applies.
  assert.deepEqual(read('server.settings'), {
    cleanupProtectedKeywords: ['warranty', 'garanti'],
    cleanupColdKeepKeywords: [],
    undoSendSeconds: 0,
  });
  assert.deepEqual(read('prefs'), { theme: 'dark', readingPaneMinWidth: 768 });
  sqlite.close();
});
