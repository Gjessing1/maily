/**
 * Orphan-file GC. Pins the contract that makes an unattended `unlink` sweep safe:
 *  - a file is kept while ANY `messages.source_path` / `attachments.storage_path` points at it;
 *  - an unreferenced file is kept until it outlives the grace window (in-flight capture);
 *  - emptied message/account dirs are pruned, the roots themselves never;
 *  - when too large a share of files looks orphaned, nothing at all is deleted.
 *
 * Same bootstrap as purge.test.ts: point MAILY_DATA_DIR at a throwaway dir BEFORE the dynamic
 * import so the shared db/env pick it up, then run migrations.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after, before, beforeEach } from 'node:test';
import type * as DbClientNS from '../db/client.js';
import type * as SchemaNS from '../db/schema.js';
import type * as GcNS from './orphanGc.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'maily-orphan-gc-test-'));
process.env.MAILY_DATA_DIR = tmpRoot;

let db: (typeof DbClientNS)['db'];
let schema: typeof SchemaNS;
let G: typeof GcNS;
let attachmentsDir: string;
let sourceDir: string;

const DAY = 24 * 60 * 60 * 1000;
const ACCOUNT = 'acct-1';

before(async () => {
  const client = await import('../db/client.js');
  const { runMigrations } = await import('../db/migrate.js');
  runMigrations();
  db = client.db;
  schema = await import('../db/schema.js');
  G = await import('./orphanGc.js');
  const { env } = await import('../env.js');
  attachmentsDir = env.attachmentsDir;
  sourceDir = env.sourceDir;
  db.insert(schema.accounts)
    .values({ id: ACCOUNT, email: 'a@me.example', provider: 'imap', imapHost: 'i', smtpHost: 's' })
    .run();
});

after(() => rmSync(tmpRoot, { recursive: true, force: true }));

beforeEach(() => {
  db.delete(schema.attachments).run();
  db.delete(schema.messages).run();
  rmSync(attachmentsDir, { recursive: true, force: true });
  rmSync(sourceDir, { recursive: true, force: true });
  mkdirSync(attachmentsDir, { recursive: true });
  mkdirSync(sourceDir, { recursive: true });
});

/** Write a file aged `ageMs` into the past. */
function file(path: string, ageMs = 2 * DAY, bytes = 10): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes, 1));
  const t = new Date(Date.now() - ageMs);
  utimesSync(path, t, t);
  return path;
}

/** Insert a message row whose `source_path` points at `sourcePath` (or null). */
function message(sourcePath: string | null): string {
  const id = randomUUID();
  db.insert(schema.messages).values({ id, accountId: ACCOUNT, sourcePath }).run();
  return id;
}

/** Insert an attachment row on `messageId` whose `storage_path` is `storagePath`. */
function attachment(messageId: string, storagePath: string): void {
  db.insert(schema.attachments).values({ id: randomUUID(), messageId, storagePath }).run();
}

/** `count` referenced source files, so the orphan ratio stays under the brake. */
function referencedFiller(count: number): void {
  for (let i = 0; i < count; i++) {
    const id = randomUUID();
    const p = file(join(sourceDir, ACCOUNT, id, 'source.eml'));
    message(p);
  }
}

test('removes old unreferenced files and keeps referenced ones', async () => {
  referencedFiller(8);
  const keptSrc = file(join(sourceDir, ACCOUNT, 'kept', 'source.eml'));
  const msgId = message(keptSrc);
  const keptAtt = file(join(attachmentsDir, ACCOUNT, msgId, 'att-1'));
  const keptFlat = file(join(attachmentsDir, 'legacy-flat-att'));
  attachment(msgId, keptAtt);
  attachment(msgId, keptFlat);

  const orphanSrc = file(join(sourceDir, ACCOUNT, 'gone', 'source.eml'), 2 * DAY, 100);
  const orphanAtt = file(join(attachmentsDir, ACCOUNT, 'gone', 'att-9'), 2 * DAY, 50);

  const res = await G.runOrphanGc();
  assert.equal(res.aborted, undefined);
  assert.equal(res.scanned, 13);
  assert.equal(res.deleted, 2);
  assert.equal(res.bytes, 150);
  for (const p of [keptSrc, keptAtt, keptFlat]) assert.ok(existsSync(p), `${p} kept`);
  assert.ok(!existsSync(orphanSrc));
  assert.ok(!existsSync(orphanAtt));
  // The emptied message dirs go; the still-populated account dir and the roots stay.
  assert.ok(!existsSync(dirname(orphanSrc)));
  assert.ok(!existsSync(dirname(orphanAtt)));
  assert.ok(existsSync(join(sourceDir, ACCOUNT)));
  assert.ok(existsSync(sourceDir));
});

test('a file whose row exists but no longer points at it is an orphan', async () => {
  referencedFiller(8);
  const id = message(null); // e.g. a purge that nulled source_path but failed to unlink
  const stale = file(join(sourceDir, ACCOUNT, id, 'source.eml'));
  const res = await G.runOrphanGc();
  assert.equal(res.deleted, 1);
  assert.ok(!existsSync(stale));
});

test('spares unreferenced files inside the grace window', async () => {
  referencedFiller(8);
  // Live capture writes source.eml under a pre-minted UUID before inserting the row.
  const inFlight = file(join(sourceDir, ACCOUNT, randomUUID(), 'source.eml'), 60_000);
  const res = await G.runOrphanGc();
  assert.equal(res.orphans, 0);
  assert.ok(existsSync(inFlight));
});

test('prunes an account dir once its last message dir is gone', async () => {
  referencedFiller(8);
  const lone = file(join(attachmentsDir, 'acct-2', randomUUID(), 'att'));
  await G.runOrphanGc();
  assert.ok(!existsSync(join(attachmentsDir, 'acct-2')));
  assert.ok(existsSync(attachmentsDir));
  assert.ok(!existsSync(lone));
});

test('safety brake: a mostly-unreferenced store deletes nothing', async () => {
  // Mimics a data dir that doesn't match the DB: 2 referenced, 3 unreferenced (60% > 25%).
  referencedFiller(2);
  const strays = [1, 2, 3].map((i) => file(join(sourceDir, ACCOUNT, `stray-${i}`, 'source.eml')));
  const res = await G.runOrphanGc();
  assert.match(res.aborted ?? '', /deleting nothing/);
  assert.equal(res.deleted, 0);
  for (const p of strays) assert.ok(existsSync(p));
});

test('an empty store is a clean no-op', async () => {
  const res = await G.runOrphanGc();
  assert.deepEqual(res, { scanned: 0, orphans: 0, deleted: 0, bytes: 0 });
});
