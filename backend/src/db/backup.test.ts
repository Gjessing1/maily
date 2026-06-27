/**
 * WAL-safe snapshot coverage. Asserts `backupDatabaseTo` produces a standalone, consistent copy
 * (every committed row present, no `-wal` sidecar needed to read it), cleans up its temp file, and
 * atomically overwrites a previous snapshot. Bootstraps an isolated temp MAILY_DATA_DIR before the
 * dynamic import so importing the module (→ db/client singleton + env mkdir) doesn't touch real data.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import Database from 'better-sqlite3';

const tmpRoot = mkdtempSync(join(tmpdir(), 'maily-backup-test-'));
process.env.MAILY_DATA_DIR = tmpRoot;

let backupDatabaseTo: typeof import('./backup.js').backupDatabaseTo;

before(async () => {
  ({ backupDatabaseTo } = await import('./backup.js'));
});

after(() => rmSync(tmpRoot, { recursive: true, force: true }));

test('writes a standalone, readable snapshot holding every committed row', async () => {
  const src = new Database(join(tmpRoot, 'src.sqlite'));
  src.pragma('journal_mode = WAL');
  src.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  const insert = src.prepare('INSERT INTO t (v) VALUES (?)');
  for (let i = 0; i < 100; i++) insert.run(`row-${i}`);

  const dest = join(tmpRoot, 'snap.bak');
  const bytes = await backupDatabaseTo(dest, src);
  assert.ok(bytes > 0, 'snapshot has bytes');
  assert.ok(!existsSync(`${dest}.tmp`), 'temp file renamed away');

  // Opens standalone (no -wal sidecar) and holds all committed rows → consistent snapshot.
  const snap = new Database(dest, { readonly: true });
  const { n } = snap.prepare('SELECT count(*) AS n FROM t').get() as { n: number };
  assert.equal(n, 100);
  snap.close();
  src.close();
});

test('atomically overwrites a previous snapshot with newer state', async () => {
  const src = new Database(join(tmpRoot, 'src2.sqlite'));
  src.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
  const dest = join(tmpRoot, 'roll.bak');

  await backupDatabaseTo(dest, src);
  src.exec('INSERT INTO t DEFAULT VALUES');
  src.exec('INSERT INTO t DEFAULT VALUES');
  await backupDatabaseTo(dest, src);

  const snap = new Database(dest, { readonly: true });
  const { n } = snap.prepare('SELECT count(*) AS n FROM t').get() as { n: number };
  assert.equal(n, 2, 'second snapshot reflects rows added after the first');
  snap.close();
  src.close();
});
