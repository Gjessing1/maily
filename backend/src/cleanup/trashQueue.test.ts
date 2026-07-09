/**
 * Cleanup trash-queue coverage (ROADMAP Phase 6b). Pins the parts that don't touch IMAP:
 *  - enqueue is idempotent (the unique index on message_id dedupes re-queues),
 *  - the runner's claim + backoff: with no engine registered a due batch can't be MOVEd, so
 *    rows stay pending with a future backoff gate and aren't immediately re-claimed,
 *  - local-only (detached) mail is trashed with a local relink into the trash folder — no
 *    engine/IMAP involved, so it works even for offline accounts.
 * The IMAP MOVE itself rides the shared, manually-verified imap/move.ts helper.
 *
 * Same throwaway-DB bootstrap as slices.test.ts (point MAILY_DATA_DIR before the dynamic
 * import, then migrate so the cleanup_queue table + its FK to messages exist).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import test, { after, before, beforeEach } from 'node:test';
import type * as SchemaNS from '../db/schema.js';
import type * as DbClientNS from '../db/client.js';
import type * as TrashQueueNS from './trashQueue.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'maily-trashq-test-'));
process.env.MAILY_DATA_DIR = tmpRoot;

let db: (typeof DbClientNS)['db'];
let schema: typeof SchemaNS;
let Q: typeof TrashQueueNS;

before(async () => {
  const client = await import('../db/client.js');
  const { runMigrations } = await import('../db/migrate.js');
  runMigrations();
  db = client.db;
  schema = await import('../db/schema.js');
  Q = await import('./trashQueue.js');
});

after(() => rmSync(tmpRoot, { recursive: true, force: true }));

beforeEach(() => {
  db.delete(schema.cleanupQueue).run();
  db.delete(schema.messageFolders).run();
  db.delete(schema.messages).run();
  db.delete(schema.folders).run();
  db.delete(schema.accounts).run();
});

function seedMessage(opts: { localOnly?: boolean } = {}): { id: string; accountId: string } {
  const accountId = randomUUID();
  db.insert(schema.accounts)
    .values({
      id: accountId,
      email: 'a@me.example',
      provider: 'imap',
      imapHost: 'i',
      smtpHost: 's',
    })
    .run();
  const id = randomUUID();
  db.insert(schema.messages)
    .values({ id, accountId, fromAddress: 'x@y.example', localOnly: opts.localOnly ?? false })
    .run();
  return { id, accountId };
}

function seedFolder(accountId: string, role: 'inbox' | 'trash'): string {
  const id = randomUUID();
  db.insert(schema.folders).values({ id, accountId, path: role, name: role, role }).run();
  return id;
}

test('enqueueTrash dedupes re-queues of the same message', () => {
  const m = seedMessage();
  assert.equal(Q.enqueueTrash([m], 'cold-storage'), 1, 'first enqueue inserts');
  assert.equal(Q.enqueueTrash([m], 'cold-storage'), 0, 'duplicate enqueue is a no-op');
  assert.deepEqual(Q.queueStatus(), { pending: 1, failed: 0, done: 0 });
});

test('runTrashQueueOnce: no engine → backoff, not re-claimed immediately', async () => {
  const m = seedMessage();
  Q.enqueueTrash([m], 'cold-storage');

  // No engine is registered in this test process, so the batch can't be MOVEd.
  const moved = await Q.runTrashQueueOnce();
  assert.equal(moved, 0, 'nothing moved without an engine');

  const row = db
    .select()
    .from(schema.cleanupQueue)
    .where(eq(schema.cleanupQueue.messageId, m.id))
    .get();
  assert.equal(row!.status, 'pending', 'stays pending (retryable)');
  assert.equal(row!.attempts, 1, 'attempt counted');
  assert.ok(row!.nextAttemptAt && row!.nextAttemptAt.getTime() > Date.now(), 'backoff gate armed');

  // The backoff gate blocks an immediate re-claim.
  assert.equal(await Q.runTrashQueueOnce(), 0, 'not re-claimed before the gate passes');
});

test('runTrashQueueOnce: local-only mail is trashed with a local relink, no IMAP needed', async () => {
  const m = seedMessage({ localOnly: true });
  const inboxId = seedFolder(m.accountId, 'inbox');
  const trashId = seedFolder(m.accountId, 'trash');
  // The detach flow froze the message's old mapping in place — it still "sits" in the inbox.
  db.insert(schema.messageFolders).values({ messageId: m.id, folderId: inboxId, uid: 7 }).run();

  Q.enqueueTrash([m], 'storage');
  // No engine registered: the local path must succeed anyway (works for offline accounts).
  const moved = await Q.runTrashQueueOnce();
  assert.equal(moved, 1, 'the local move counts as moved');

  const queueRow = db
    .select()
    .from(schema.cleanupQueue)
    .where(eq(schema.cleanupQueue.messageId, m.id))
    .get();
  assert.equal(queueRow!.status, 'done', 'queue row completed');

  const mappings = db
    .select()
    .from(schema.messageFolders)
    .where(eq(schema.messageFolders.messageId, m.id))
    .all();
  assert.equal(mappings.length, 1, 'old mappings replaced by exactly one');
  assert.equal(mappings[0]!.folderId, trashId, 'now mapped into the trash folder');
  assert.equal(mappings[0]!.uid, null, 'no server UID — the copy is local-only');
});

test('runTrashQueueOnce: local-only mail with no trash folder backs off, not silently done', async () => {
  const m = seedMessage({ localOnly: true });
  Q.enqueueTrash([m], 'storage');

  assert.equal(await Q.runTrashQueueOnce(), 0, 'nothing moved without a trash folder');
  const row = db
    .select()
    .from(schema.cleanupQueue)
    .where(eq(schema.cleanupQueue.messageId, m.id))
    .get();
  assert.equal(row!.status, 'pending', 'stays pending (retryable)');
  assert.equal(row!.attempts, 1, 'attempt counted');
});
