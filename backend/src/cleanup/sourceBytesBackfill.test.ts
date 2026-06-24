/**
 * source_bytes backfill (storage metric / detach size estimate). Pins the self-healing
 * contract: every archived row with a present `.eml` ends up holding that file's real
 * size, whether it started NULL (archived before the column existed) or 0 (a buggy
 * write) — and a row whose file is gone is recorded 0 rather than crashing or retrying.
 *
 * Same bootstrap as slices.test.ts: point MAILY_DATA_DIR at a throwaway dir BEFORE the
 * dynamic import so the shared db/env pick it up, then run migrations.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before, beforeEach } from 'node:test';
import { eq } from 'drizzle-orm';
import type * as SchemaNS from '../db/schema.js';
import type * as DbClientNS from '../db/client.js';
import type * as BackfillNS from './sourceBytesBackfill.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'maily-backfill-test-'));
process.env.MAILY_DATA_DIR = tmpRoot;

let db: (typeof DbClientNS)['db'];
let schema: typeof SchemaNS;
let backfillSourceBytes: (typeof BackfillNS)['backfillSourceBytes'];

before(async () => {
  const client = await import('../db/client.js');
  const { runMigrations } = await import('../db/migrate.js');
  runMigrations();
  db = client.db;
  schema = await import('../db/schema.js');
  ({ backfillSourceBytes } = await import('./sourceBytesBackfill.js'));
});

after(() => rmSync(tmpRoot, { recursive: true, force: true }));

beforeEach(() => {
  db.delete(schema.messages).run();
  db.delete(schema.accounts).run();
});

function seedAccount(): string {
  const id = randomUUID();
  db.insert(schema.accounts)
    .values({ id, email: `${id}@me.example`, provider: 'imap', imapHost: 'i', smtpHost: 's' })
    .run();
  return id;
}

/** Insert an archived row; writes a real `.eml` of `bytes` length unless `noFile`. */
function seedArchived(
  accountId: string,
  opts: { sourceBytes: number | null; bytes: number; noFile?: boolean },
): string {
  const id = randomUUID();
  const sourcePath = join(tmpRoot, `${id}.eml`);
  if (!opts.noFile) writeFileSync(sourcePath, Buffer.alloc(opts.bytes, 0x61));
  db.insert(schema.messages)
    .values({
      id,
      accountId,
      fromAddress: 'a@b.example',
      receivedAt: new Date(),
      sourcePath,
      sourceBytes: opts.sourceBytes,
    })
    .run();
  return id;
}

function sourceBytesOf(id: string): number | null {
  return (
    db
      .select({ sourceBytes: schema.messages.sourceBytes })
      .from(schema.messages)
      .where(eq(schema.messages.id, id))
      .get()?.sourceBytes ?? null
  );
}

test('fills NULL source_bytes from the on-disk .eml size', () => {
  const acc = seedAccount();
  const id = seedArchived(acc, { sourceBytes: null, bytes: 4096 });

  const res = backfillSourceBytes();

  assert.equal(res.filled, 1);
  assert.equal(res.missing, 0);
  assert.equal(sourceBytesOf(id), 4096);
});

test('self-heals a row left at 0 despite a real .eml', () => {
  const acc = seedAccount();
  const id = seedArchived(acc, { sourceBytes: 0, bytes: 1234 });

  backfillSourceBytes();

  assert.equal(sourceBytesOf(id), 1234);
});

test('leaves an already-measured row untouched and is a no-op on re-run', () => {
  const acc = seedAccount();
  const good = seedArchived(acc, { sourceBytes: 4096, bytes: 999 }); // value != file size on purpose
  seedArchived(acc, { sourceBytes: null, bytes: 512 });

  backfillSourceBytes();
  assert.equal(sourceBytesOf(good), 4096, 'a positive value is never recomputed');

  const second = backfillSourceBytes();
  assert.equal(second.pending, 0, 'nothing left to do once every .eml is measured');
});

test('records 0 for a missing .eml instead of crashing', () => {
  const acc = seedAccount();
  const id = seedArchived(acc, { sourceBytes: null, bytes: 0, noFile: true });

  const res = backfillSourceBytes();

  assert.equal(res.missing, 1);
  assert.equal(sourceBytesOf(id), 0);
});
