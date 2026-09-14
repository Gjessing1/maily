/**
 * Cleanup cache contract: a slice compute is memoised (same object back, no recompute)
 * until a trigger bumps the durable data version, after which the next read reflects the
 * new DB state. Same bootstrap as slices.test.ts — point MAILY_DATA_DIR at a throwaway
 * dir BEFORE the dynamic import so the shared db/env pick it up, then run migrations.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { eq } from 'drizzle-orm';
import type * as SchemaNS from '../db/schema.js';
import type * as DbClientNS from '../db/client.js';
import type * as CacheNS from './cache.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'maily-cleanup-cache-test-'));
process.env.MAILY_DATA_DIR = tmpRoot;

let db: (typeof DbClientNS)['db'];
let schema: typeof SchemaNS;
let C: typeof CacheNS;

before(async () => {
  const client = await import('../db/client.js');
  const { runMigrations } = await import('../db/migrate.js');
  runMigrations();
  db = client.db;
  schema = await import('../db/schema.js');
  C = await import('./cache.js');
});

after(() => rmSync(tmpRoot, { recursive: true, force: true }));

function seedMessage(accountId: string, fromAddress: string): string {
  const id = randomUUID();
  db.insert(schema.messages)
    .values({ id, accountId, fromAddress, subject: 'Hi', bodyText: 'body', receivedAt: new Date() })
    .run();
  return id;
}

test('cachedSliceData memoises until an underlying DB write invalidates it', () => {
  const accountId = randomUUID();
  db.insert(schema.accounts)
    .values({
      id: accountId,
      email: 'me@me.example',
      provider: 'imap',
      imapHost: 'i',
      smtpHost: 's',
    })
    .run();
  seedMessage(accountId, 'a@promo.example');

  const first = C.cachedSliceData('storage');
  assert.equal(first.totalMessages, 1);

  // No signal is needed: the INSERT trigger makes the next read recompute.
  const newId = seedMessage(accountId, 'b@promo.example');
  const fresh = C.cachedSliceData('storage');
  assert.notEqual(fresh, first);
  assert.equal(fresh.totalMessages, 2);

  // Summary follows the same version discipline.
  const summary = C.cachedSummary();
  assert.equal(summary.totalMessages, 2);
  db.update(schema.messages)
    .set({ deletedAt: new Date() })
    .where(eq(schema.messages.id, newId))
    .run();
  assert.notEqual(C.cachedSummary(), summary);
});

test('flag writes do not invalidate cleanup aggregates', () => {
  const accountId = randomUUID();
  db.insert(schema.accounts)
    .values({
      id: accountId,
      email: 'flags@me.example',
      provider: 'imap',
      imapHost: 'i',
      smtpHost: 's',
    })
    .run();
  const messageId = seedMessage(accountId, 'sender@promo.example');

  const slice = C.cachedSliceData('storage');
  const summary = C.cachedSummary();
  db.update(schema.messages)
    .set({ seen: true, flagged: true })
    .where(eq(schema.messages.id, messageId))
    .run();

  assert.equal(C.cachedSliceData('storage'), slice);
  assert.equal(C.cachedSummary(), summary);
});

test('message versioning is column-scoped around archive metadata', () => {
  const accountId = randomUUID();
  db.insert(schema.accounts)
    .values({
      id: accountId,
      email: 'archive@me.example',
      provider: 'imap',
      imapHost: 'i',
      smtpHost: 's',
    })
    .run();
  const messageId = seedMessage(accountId, 'archive@promo.example');
  const first = C.cachedSliceData('storage');

  // The path is not part of cleanup analytics, so the archive sweep may set it freely.
  db.update(schema.messages)
    .set({ sourcePath: '/tmp/example.eml' })
    .where(eq(schema.messages.id, messageId))
    .run();
  assert.equal(C.cachedSliceData('storage'), first);

  // The byte count does change cleanup totals and must invalidate.
  db.update(schema.messages)
    .set({ sourceBytes: 1234 })
    .where(eq(schema.messages.id, messageId))
    .run();
  const fresh = C.cachedSliceData('storage');
  assert.notEqual(fresh, first);
  assert.equal(fresh.totalBytes, first.totalBytes - 4 + 1234);
});
