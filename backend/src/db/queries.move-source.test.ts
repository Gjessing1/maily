/**
 * `moveSourceFolder` — which copy Report spam / Not spam takes a message out of: the inbox copy
 * first, then a role folder (Gmail's All Mail for archived mail) before a custom label, and
 * never Trash or the destination itself.
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

const tmpRoot = mkdtempSync(join(tmpdir(), 'maily-movesrc-test-'));
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

const ROLES = ['inbox', 'archive', 'trash', 'junk', 'custom'] as const;

/** A message mapped into the given folders of a fresh account. */
function seed(mappedInto: (typeof ROLES)[number][]) {
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
  const f = Object.fromEntries(ROLES.map((r) => [r, randomUUID()])) as Record<
    (typeof ROLES)[number],
    string
  >;
  db.insert(schema.folders)
    .values(ROLES.map((role) => ({ id: f[role], accountId, path: role, name: role, role })))
    .run();
  const msg = randomUUID();
  db.insert(schema.messages).values({ id: msg, accountId, fromAddress: 'x@y.example' }).run();
  mappedInto.forEach((role, i) =>
    db
      .insert(schema.messageFolders)
      .values({ messageId: msg, folderId: f[role], uid: i + 1 })
      .run(),
  );
  return { msg, f };
}

test('report spam takes the inbox copy over every other mapping', () => {
  const { msg, f } = seed(['custom', 'archive', 'inbox']);
  assert.deepEqual(q.moveSourceFolder(msg, 'junk'), { id: f.inbox, role: 'inbox' });
});

test('archived mail is reported from its role folder before a custom label', () => {
  const { msg, f } = seed(['custom', 'archive']);
  assert.deepEqual(q.moveSourceFolder(msg, 'junk'), { id: f.archive, role: 'archive' });
});

test('trash and the destination never count as a source', () => {
  assert.equal(q.moveSourceFolder(seed(['trash']).msg, 'junk'), undefined);
  assert.equal(q.moveSourceFolder(seed(['junk']).msg, 'junk'), undefined);
  const { msg, f } = seed(['junk']);
  assert.deepEqual(q.moveSourceFolder(msg, 'inbox'), { id: f.junk, role: 'junk' });
});
