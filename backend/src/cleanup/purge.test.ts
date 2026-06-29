/**
 * Local "Purge Trash" coverage. Pins the contract that makes purge safe:
 *  - it reclaims disk (unlinks the `.eml` + attachment files, nulls body/source) but keeps a
 *    lightweight tombstone row WITH its identity, flagged `purged_at`;
 *  - purged shells are hidden even inside trash folders, while ordinary tombstoned mail still shows;
 *  - a re-`upsertMessage` of a purged message's identity dedups (no re-insert, body stays null) —
 *    proving the provider's still-present Trash copy is not re-downloaded on the next sync.
 *
 * Same bootstrap as slices.test.ts: point MAILY_DATA_DIR at a throwaway dir BEFORE the dynamic
 * import so the shared db/env pick it up, then run migrations (FTS triggers included).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before, beforeEach } from 'node:test';
import { eq } from 'drizzle-orm';
import type * as SchemaNS from '../db/schema.js';
import type * as DbClientNS from '../db/client.js';
import type * as PurgeNS from './purge.js';
import type * as QueriesNS from '../db/queries.js';
import type * as StoreNS from '../imap/store.js';
import type { ParsedMessage } from '../imap/types.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'maily-purge-test-'));
process.env.MAILY_DATA_DIR = tmpRoot;

let db: (typeof DbClientNS)['db'];
let schema: typeof SchemaNS;
let P: typeof PurgeNS;
let Q: typeof QueriesNS;
let store: typeof StoreNS;

before(async () => {
  const client = await import('../db/client.js');
  const { runMigrations } = await import('../db/migrate.js');
  runMigrations();
  db = client.db;
  schema = await import('../db/schema.js');
  P = await import('./purge.js');
  Q = await import('../db/queries.js');
  store = await import('../imap/store.js');
});

after(() => rmSync(tmpRoot, { recursive: true, force: true }));

beforeEach(() => {
  db.delete(schema.attachments).run();
  db.delete(schema.messageFolders).run();
  db.delete(schema.messages).run();
  db.delete(schema.folders).run();
  db.delete(schema.accounts).run();
});

function seedAccount(): string {
  const id = randomUUID();
  db.insert(schema.accounts)
    .values({ id, email: `${id}@me.example`, provider: 'imap', imapHost: 'i', smtpHost: 's' })
    .run();
  return id;
}

function seedFolder(accountId: string, role: 'inbox' | 'trash'): string {
  const id = randomUUID();
  db.insert(schema.folders).values({ id, accountId, path: role, name: role, role }).run();
  return id;
}

/** Seed a message mapped into `folderId` with on-disk source + attachment files; returns its id. */
function seedTrashed(
  accountId: string,
  folderId: string,
  opts: { messageId?: string; tombstoned?: boolean } = {},
): { id: string; sourcePath: string; attPath: string } {
  const id = randomUUID();
  const sourcePath = join(tmpRoot, `${id}.eml`);
  const attPath = join(tmpRoot, `${id}.bin`);
  writeFileSync(sourcePath, 'raw eml bytes');
  writeFileSync(attPath, 'attachment bytes');
  db.insert(schema.messages)
    .values({
      id,
      accountId,
      messageId: opts.messageId ?? null,
      fromAddress: 'sender@promo.example',
      subject: 'Old promo',
      bodyText: 'big body text',
      snippet: 'big body',
      contentBytes: 13,
      sourcePath,
      sourceBytes: 13,
      receivedAt: new Date(),
      deletedAt: opts.tombstoned === false ? null : new Date(),
    })
    .run();
  db.insert(schema.messageFolders).values({ messageId: id, folderId, uid: 1 }).run();
  db.insert(schema.attachments)
    .values({ messageId: id, filename: 'a.bin', sizeBytes: 17, storagePath: attPath })
    .run();
  return { id, sourcePath, attPath };
}

function row(id: string) {
  return db.select().from(schema.messages).where(eq(schema.messages.id, id)).get();
}

test('purgeTrashFolder: strips heavy data + files but keeps an identity-bearing tombstone', () => {
  const acct = seedAccount();
  const trash = seedFolder(acct, 'trash');
  const { id, sourcePath, attPath } = seedTrashed(acct, trash, { messageId: '<m1@x>' });

  const res = P.purgeTrashFolder(trash);
  assert.equal(res.purged, 1);

  const m = row(id);
  assert.ok(m, 'the row survives as a tombstone (deep links never 404)');
  assert.equal(m!.messageId, '<m1@x>', 'identity kept so resync dedups instead of re-downloading');
  assert.notEqual(m!.purgedAt, null, 'purged_at stamped');
  assert.notEqual(m!.deletedAt, null, 'tombstoned');
  assert.equal(m!.bodyText, null, 'body reclaimed');
  assert.equal(m!.sourcePath, null, 'source path cleared');
  assert.equal(m!.sourceBytes, null);

  const atts = db
    .select()
    .from(schema.attachments)
    .where(eq(schema.attachments.messageId, id))
    .all();
  assert.equal(atts.length, 0, 'attachment rows removed');
  assert.equal(existsSync(sourcePath), false, '.eml file unlinked');
  assert.equal(existsSync(attPath), false, 'attachment file unlinked');
});

test('purgeTrashFolder: trash list hides purged but still shows tombstoned mail', () => {
  const acct = seedAccount();
  const trash = seedFolder(acct, 'trash');
  const purged = seedTrashed(acct, trash);
  const kept = seedTrashed(acct, trash); // tombstoned, not purged

  assert.equal(
    Q.folderMessageCount(trash),
    2,
    'both visible before purge (trash shows tombstones)',
  );

  // Purge only `purged` by removing the other from the folder first would be artificial; instead
  // purge the whole folder, then re-add a fresh tombstoned message to represent "still in trash".
  P.purgeTrashFolder(trash);
  const stillThere = seedTrashed(acct, trash);

  const ids = Q.listMessages(trash, 50).map((m) => m.id);
  assert.ok(!ids.includes(purged.id), 'purged shell hidden in trash');
  assert.ok(!ids.includes(kept.id), 'kept (also purged in the folder sweep) hidden too');
  assert.ok(ids.includes(stillThere.id), 'a fresh tombstoned message still shows in trash');
  assert.equal(Q.folderMessageCount(trash), 1, 'count reflects only the non-purged tombstone');
});

test('purgeTrashFolder: a re-synced purged message dedups — body is NOT re-downloaded', () => {
  const acct = seedAccount();
  const trash = seedFolder(acct, 'trash');
  const { id } = seedTrashed(acct, trash, { messageId: '<m2@x>' });
  P.purgeTrashFolder(trash);

  // Simulate a full Trash resync re-sighting the still-present provider copy: upsert by the same
  // identity. It must dedup (no insert) and must NOT restore the reclaimed body.
  const parsed: ParsedMessage = {
    messageId: '<m2@x>',
    gmMsgId: null,
    providerThreadId: null,
    inReplyTo: null,
    references: null,
    subject: 'Old promo',
    fromName: 'Sender',
    fromAddress: 'sender@promo.example',
    to: [],
    cc: [],
    snippet: 'big body',
    bodyText: 'RE-DOWNLOADED BODY',
    bodyHtml: null,
    bodyCalendar: null,
    sourcePath: null,
    receivedAt: new Date(),
    sentAt: null,
    flags: { seen: false, flagged: false, answered: false, draft: false },
    attachments: [],
  };
  const result = store.upsertMessage(acct, trash, 1, parsed, 'trash');

  assert.equal(result.inserted, false, 'dedup hit — no new row');
  assert.equal(result.id, id, 'same internal id');
  const m = row(id);
  assert.equal(m!.bodyText, null, 'body stayed reclaimed — resync did not re-store it');
  assert.notEqual(m!.purgedAt, null, 'still flagged purged');
});

test('purgeTrashFolder: refuses a non-trash folder', () => {
  const acct = seedAccount();
  const inbox = seedFolder(acct, 'inbox');
  assert.throws(() => P.purgeTrashFolder(inbox), /not a trash folder/);
});
