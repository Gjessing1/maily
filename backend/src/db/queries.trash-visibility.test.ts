/**
 * Trash-visibility rule (§13 tombstones): a delete/cleanup tombstones the message locally and
 * MOVEs it to Trash — so in trash-role folder views the tombstoned row IS the expected content
 * and must stay listable/countable, while every other view keeps hiding tombstones. Pins the
 * regression where cleanup-trashed mail "vanished" (moved on the server but invisible in the
 * app's own Trash).
 *
 * Same throwaway-DB bootstrap as trashQueue.test.ts (point MAILY_DATA_DIR before the dynamic
 * import, then migrate).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before, beforeEach } from 'node:test';
import type * as SchemaNS from './schema.js';
import type * as DbClientNS from './client.js';
import type * as QueriesNS from './queries.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'maily-trashvis-test-'));
process.env.MAILY_DATA_DIR = tmpRoot;

let db: (typeof DbClientNS)['db'];
let schema: typeof SchemaNS;
let q: typeof QueriesNS;

before(async () => {
  const client = await import('./client.js');
  const { runMigrations } = await import('./migrate.js');
  runMigrations();
  db = client.db;
  schema = await import('./schema.js');
  q = await import('./queries.js');
});

after(() => rmSync(tmpRoot, { recursive: true, force: true }));

beforeEach(() => {
  db.delete(schema.messageFolders).run();
  db.delete(schema.messages).run();
  db.delete(schema.folders).run();
  db.delete(schema.accounts).run();
});

function seed() {
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
  const inboxId = randomUUID();
  const trashId = randomUUID();
  db.insert(schema.folders)
    .values([
      { id: inboxId, accountId, path: 'INBOX', name: 'Inbox', role: 'inbox' },
      { id: trashId, accountId, path: 'Trash', name: 'Trash', role: 'trash' },
    ])
    .run();
  const seedMsg = (folderId: string, deleted: boolean): string => {
    const id = randomUUID();
    db.insert(schema.messages)
      .values({
        id,
        accountId,
        fromAddress: 'x@y.example',
        receivedAt: new Date(),
        deletedAt: deleted ? new Date() : null,
      })
      .run();
    db.insert(schema.messageFolders).values({ messageId: id, folderId, uid: 1 }).run();
    return id;
  };
  return { accountId, inboxId, trashId, seedMsg };
}

test('tombstoned messages stay listable in the trash-role folder, hidden elsewhere', () => {
  const { inboxId, trashId, seedMsg } = seed();
  const live = seedMsg(inboxId, false);
  seedMsg(inboxId, true); // tombstoned but not yet moved — hidden everywhere
  const trashed = seedMsg(trashId, true); // cleanup-trashed: tombstone + trash mapping

  assert.deepEqual(
    q.listMessages(inboxId, 10).map((m) => m.id),
    [live],
    'inbox hides tombstones',
  );
  assert.deepEqual(
    q.listMessages(trashId, 10).map((m) => m.id),
    [trashed],
    'trash folder shows its tombstoned content',
  );
  assert.deepEqual(
    q.listUnifiedByRole('trash', 10).map((m) => m.id),
    [trashed],
    'unified trash shows it too',
  );
  assert.deepEqual(
    q.listUnifiedByRole('inbox', 10).map((m) => m.id),
    [live],
    'unified inbox still hides tombstones',
  );
  assert.equal(q.folderMessageCount(inboxId), 1, 'inbox count excludes tombstones');
  assert.equal(q.folderMessageCount(trashId), 1, 'trash count includes them');
});
