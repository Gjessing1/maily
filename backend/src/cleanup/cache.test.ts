/**
 * Cleanup cache contract: a slice compute is memoised (same object back, no recompute)
 * until a mail mutation signal bumps the data version, after which the next read reflects
 * the new DB state. Same bootstrap as slices.test.ts — point MAILY_DATA_DIR at a throwaway
 * dir BEFORE the dynamic import so the shared db/env pick it up, then run migrations.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import type * as SchemaNS from '../db/schema.js';
import type * as DbClientNS from '../db/client.js';
import type * as CacheNS from './cache.js';
import type * as EventsNS from '../events.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'maily-cleanup-cache-test-'));
process.env.MAILY_DATA_DIR = tmpRoot;

let db: (typeof DbClientNS)['db'];
let schema: typeof SchemaNS;
let C: typeof CacheNS;
let E: typeof EventsNS;

before(async () => {
  const client = await import('../db/client.js');
  const { runMigrations } = await import('../db/migrate.js');
  runMigrations();
  db = client.db;
  schema = await import('../db/schema.js');
  C = await import('./cache.js');
  E = await import('../events.js');
});

after(() => rmSync(tmpRoot, { recursive: true, force: true }));

function seedMessage(accountId: string, fromAddress: string): string {
  const id = randomUUID();
  db.insert(schema.messages)
    .values({ id, accountId, fromAddress, subject: 'Hi', bodyText: 'body', receivedAt: new Date() })
    .run();
  return id;
}

test('cachedSliceData memoises until a mail signal invalidates it', () => {
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

  // A direct DB write without a signal is served stale — that's the memoisation working.
  const newId = seedMessage(accountId, 'b@promo.example');
  assert.equal(C.cachedSliceData('storage'), first);

  // Any mail mutation signal bumps the version; the next read recomputes.
  E.emitSignal({ type: 'mail:new', accountId, messageId: newId });
  const fresh = C.cachedSliceData('storage');
  assert.notEqual(fresh, first);
  assert.equal(fresh.totalMessages, 2);

  // Summary follows the same version discipline.
  const summary = C.cachedSummary();
  assert.equal(summary.totalMessages, 2);
  E.emitSignal({ type: 'mail:deleted', accountId, messageId: newId });
  assert.notEqual(C.cachedSummary(), summary);
});
