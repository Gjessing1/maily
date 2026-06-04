/**
 * Characterization net for the persistence engine (Refactoring Phase 1). These tests
 * PIN current behaviour of the highest-risk, lowest-covered store logic before any
 * restructuring touches it:
 *   - identity dedup (gm_msgid first, then account-scoped message_id),
 *   - many-to-many folder mapping (one row, many (folder, uid) links),
 *   - threading via In-Reply-To / References in BOTH arrival orders (parent-first and
 *     reply-first orphan back-fill),
 *   - the tombstone model (unlink → soft-delete, re-sight un-tombstone, trash stays hidden).
 *
 * They describe what the code does today, not what it ideally should — a regression
 * tripwire, not a spec. `store.ts` reaches for the shared `db` connection at import, so
 * we point `MAILY_DATA_DIR` at a throwaway dir and dynamically import AFTER, then apply
 * the real migrations (FTS triggers included). Each test seeds a fresh account so the
 * account-scoped queries can't bleed across tests.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { eq } from 'drizzle-orm';
import type { FolderRole } from '@maily/shared';
import type * as StoreNS from './store.js';
import type * as SchemaNS from '../db/schema.js';
import type * as DbClientNS from '../db/client.js';
import type { ParsedMessage } from './types.js';

// Must be set before the db client (transitively, env.ts) is imported.
const tmpRoot = mkdtempSync(join(tmpdir(), 'maily-store-test-'));
process.env.MAILY_DATA_DIR = tmpRoot;

// Resolved in before() via dynamic import so the env var above wins. The `import type`
// namespace imports above are erased at runtime, so they don't disturb that ordering.
let store: typeof StoreNS;
let schema: typeof SchemaNS;
let rawDb: (typeof DbClientNS)['db'];

before(async () => {
  const client = await import('../db/client.js');
  const { runMigrations } = await import('../db/migrate.js');
  runMigrations();
  rawDb = client.db;
  schema = await import('../db/schema.js');
  store = await import('./store.js');
});

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

interface SeededAccount {
  accountId: string;
  /** Folder id for a seeded role; throws if the role wasn't seeded (keeps the type a plain string). */
  folder(role: FolderRole): string;
}

/** Seed an isolated account with the folders a test asks for; returns an id accessor by role. */
function seedAccount(roles: FolderRole[] = ['inbox']): SeededAccount {
  const accountId = randomUUID();
  rawDb
    .insert(schema.accounts)
    .values({
      id: accountId,
      email: `${accountId}@example.com`,
      provider: 'imap',
      imapHost: 'imap.example.com',
      smtpHost: 'smtp.example.com',
    })
    .run();
  const ids = new Map<FolderRole, string>();
  for (const role of roles) {
    const id = randomUUID();
    rawDb
      .insert(schema.folders)
      .values({ id, accountId, path: `${role}-${id}`, name: role, role })
      .run();
    ids.set(role, id);
  }
  return {
    accountId,
    folder(role) {
      const id = ids.get(role);
      if (!id) throw new Error(`folder role not seeded: ${role}`);
      return id;
    },
  };
}

/** Build a ParsedMessage with sensible empty defaults; override only what a test cares about. */
function makeParsed(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    messageId: null,
    gmMsgId: null,
    providerThreadId: null,
    inReplyTo: null,
    references: null,
    subject: 'Subject',
    fromName: 'Sender',
    fromAddress: 'sender@example.com',
    to: [],
    cc: [],
    snippet: 'snippet',
    bodyText: 'body',
    bodyHtml: null,
    sourcePath: null,
    sentAt: null,
    receivedAt: new Date('2025-06-01T00:00:00Z'),
    flags: { seen: false, flagged: false, answered: false, draft: false },
    attachments: [],
    ...overrides,
  };
}

function threadIdOf(id: string): string | null | undefined {
  return rawDb
    .select({ threadId: schema.messages.threadId })
    .from(schema.messages)
    .where(eq(schema.messages.id, id))
    .get()?.threadId;
}

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------

test('first sighting inserts; second sighting of the same message_id dedups', () => {
  const { accountId, folder } = seedAccount(['inbox']);
  const parsed = makeParsed({ messageId: '<m1@example.com>' });

  const first = store.upsertMessage(accountId, folder('inbox'), 10, parsed, 'inbox');
  assert.equal(first.inserted, true);

  const second = store.upsertMessage(accountId, folder('inbox'), 10, parsed, 'inbox');
  assert.equal(second.inserted, false);
  assert.equal(second.id, first.id, 'dedup returns the existing internal UUID');
});

test('gm_msgid is the primary dedup key — same gm_msgid dedups regardless of folder', () => {
  const { accountId, folder } = seedAccount(['inbox', 'archive']);
  const parsed = makeParsed({ gmMsgId: 'gm-1', messageId: '<m@example.com>' });

  const inbox = store.upsertMessage(accountId, folder('inbox'), 1, parsed, 'inbox');
  const allMail = store.upsertMessage(accountId, folder('archive'), 2, parsed, 'archive');

  assert.equal(allMail.inserted, false);
  assert.equal(allMail.id, inbox.id);
});

test('dedup is scoped per account — same message_id under another account inserts anew', () => {
  const a = seedAccount(['inbox']);
  const b = seedAccount(['inbox']);
  const parsed = makeParsed({ messageId: '<shared@example.com>' });

  const inA = store.upsertMessage(a.accountId, a.folder('inbox'), 1, parsed, 'inbox');
  const inB = store.upsertMessage(b.accountId, b.folder('inbox'), 1, parsed, 'inbox');

  assert.equal(inB.inserted, true);
  assert.notEqual(inB.id, inA.id);
});

test('a re-sighting refreshes flags but does not rewrite the body', () => {
  const { accountId, folder } = seedAccount(['inbox']);
  const first = store.upsertMessage(
    accountId,
    folder('inbox'),
    1,
    makeParsed({ messageId: '<m@example.com>', bodyText: 'original' }),
    'inbox',
  );

  // Same identity re-seen with the seen flag set and a (would-be) different body.
  store.upsertMessage(
    accountId,
    folder('inbox'),
    1,
    makeParsed({
      messageId: '<m@example.com>',
      bodyText: 'CHANGED',
      flags: { seen: true, flagged: true, answered: false, draft: false },
    }),
    'inbox',
  );

  const row = rawDb
    .select({
      seen: schema.messages.seen,
      flagged: schema.messages.flagged,
      bodyText: schema.messages.bodyText,
    })
    .from(schema.messages)
    .where(eq(schema.messages.id, first.id))
    .get();
  assert.equal(row?.seen, true);
  assert.equal(row?.flagged, true);
  assert.equal(row?.bodyText, 'original', 'body is written once on insert, never on re-sight');
});

// ---------------------------------------------------------------------------
// Many-to-many folder mapping
// ---------------------------------------------------------------------------

test('one message in two folders yields one row and two (folder, uid) links', () => {
  const { accountId, folder } = seedAccount(['inbox', 'archive']);
  const parsed = makeParsed({ gmMsgId: 'gm-x' });

  const r = store.upsertMessage(accountId, folder('inbox'), 11, parsed, 'inbox');
  store.upsertMessage(accountId, folder('archive'), 22, parsed, 'archive');

  const links = rawDb
    .select({ folderId: schema.messageFolders.folderId, uid: schema.messageFolders.uid })
    .from(schema.messageFolders)
    .where(eq(schema.messageFolders.messageId, r.id))
    .all();
  assert.equal(links.length, 2);
  assert.equal(store.messageIdForUid(folder('inbox'), 11), r.id);
  assert.equal(store.messageIdForUid(folder('archive'), 22), r.id);
});

test('re-linking the same (message, folder) updates the UID in place', () => {
  const { accountId, folder } = seedAccount(['inbox']);
  const r = store.upsertMessage(
    accountId,
    folder('inbox'),
    5,
    makeParsed({ gmMsgId: 'gm-y' }),
    'inbox',
  );

  // Re-sight with a new UID (e.g. after a move changed it).
  store.upsertMessage(accountId, folder('inbox'), 99, makeParsed({ gmMsgId: 'gm-y' }), 'inbox');

  assert.equal(store.messageIdForUid(folder('inbox'), 99), r.id);
  assert.equal(store.messageIdForUid(folder('inbox'), 5), undefined, 'old UID no longer maps');
  assert.deepEqual(store.knownUids(folder('inbox')), [99]);
});

// ---------------------------------------------------------------------------
// Threading
// ---------------------------------------------------------------------------

test('Gmail X-GM-THRID is used verbatim as the thread id', () => {
  const { accountId, folder } = seedAccount(['inbox']);
  const r = store.upsertMessage(
    accountId,
    folder('inbox'),
    1,
    makeParsed({ gmMsgId: 'gm-1', providerThreadId: 'thrid-7' }),
    'inbox',
  );
  assert.equal(threadIdOf(r.id), 'thrid-7');
});

test('a root with no references opens a thread keyed by its own Message-ID', () => {
  const { accountId, folder } = seedAccount(['inbox']);
  const r = store.upsertMessage(
    accountId,
    folder('inbox'),
    1,
    makeParsed({ messageId: '<root@example.com>' }),
    'inbox',
  );
  assert.equal(threadIdOf(r.id), '<root@example.com>');
});

test('parent-first: a reply inherits the parent thread via In-Reply-To', () => {
  const { accountId, folder } = seedAccount(['inbox']);
  const parent = store.upsertMessage(
    accountId,
    folder('inbox'),
    1,
    makeParsed({ messageId: '<root@example.com>' }),
    'inbox',
  );
  const reply = store.upsertMessage(
    accountId,
    folder('inbox'),
    2,
    makeParsed({ messageId: '<reply@example.com>', inReplyTo: '<root@example.com>' }),
    'inbox',
  );
  assert.equal(threadIdOf(reply.id), threadIdOf(parent.id));
});

test('parent-first: References (no In-Reply-To) still inherits the ancestor thread', () => {
  const { accountId, folder } = seedAccount(['inbox']);
  const root = store.upsertMessage(
    accountId,
    folder('inbox'),
    1,
    makeParsed({ messageId: '<root@example.com>' }),
    'inbox',
  );
  const reply = store.upsertMessage(
    accountId,
    folder('inbox'),
    2,
    makeParsed({
      messageId: '<reply@example.com>',
      references: '<root@example.com> <other@example.com>',
    }),
    'inbox',
  );
  assert.equal(threadIdOf(reply.id), threadIdOf(root.id));
});

test('reply-first (orphan): the parent arriving later back-fills the reply onto its thread', () => {
  const { accountId, folder } = seedAccount(['inbox']);
  // Reply lands first, opening its own thread.
  const reply = store.upsertMessage(
    accountId,
    folder('inbox'),
    1,
    makeParsed({ messageId: '<reply@example.com>', inReplyTo: '<root@example.com>' }),
    'inbox',
  );
  const orphanThread = threadIdOf(reply.id);
  assert.equal(orphanThread, '<reply@example.com>');

  // Parent arrives second; mergeOrphanReplies must repoint the reply onto the parent's thread.
  const parent = store.upsertMessage(
    accountId,
    folder('inbox'),
    2,
    makeParsed({ messageId: '<root@example.com>' }),
    'inbox',
  );
  assert.equal(threadIdOf(reply.id), threadIdOf(parent.id));
});

// ---------------------------------------------------------------------------
// Tombstone model
// ---------------------------------------------------------------------------

test('unlinkUids drops the mapping and soft-deletes a now fully-orphaned message', () => {
  const { accountId, folder } = seedAccount(['inbox']);
  const r = store.upsertMessage(
    accountId,
    folder('inbox'),
    7,
    makeParsed({ gmMsgId: 'gm-z' }),
    'inbox',
  );

  store.unlinkUids(folder('inbox'), [7]);

  const row = rawDb
    .select({ deletedAt: schema.messages.deletedAt })
    .from(schema.messages)
    .where(eq(schema.messages.id, r.id))
    .get();
  assert.notEqual(row?.deletedAt, null, 'fully-orphaned message is tombstoned, row survives');
  assert.deepEqual(store.knownUids(folder('inbox')), []);
});

test('unlinkUids from one of two folders keeps the message alive (still mapped elsewhere)', () => {
  const { accountId, folder } = seedAccount(['inbox', 'archive']);
  const parsed = makeParsed({ gmMsgId: 'gm-multi' });
  const r = store.upsertMessage(accountId, folder('inbox'), 1, parsed, 'inbox');
  store.upsertMessage(accountId, folder('archive'), 2, parsed, 'archive');

  store.unlinkUids(folder('inbox'), [1]);

  const row = rawDb
    .select({ deletedAt: schema.messages.deletedAt })
    .from(schema.messages)
    .where(eq(schema.messages.id, r.id))
    .get();
  assert.equal(row?.deletedAt, null, 'still mapped in archive ⇒ not tombstoned');
});

test('re-sight in a NON-trash folder clears an existing tombstone; a trash re-sight does not', () => {
  const { accountId, folder } = seedAccount(['inbox', 'trash']);
  const parsed = makeParsed({ gmMsgId: 'gm-undelete' });
  const r = store.upsertMessage(accountId, folder('inbox'), 1, parsed, 'inbox');

  // Tombstone it.
  store.unlinkUids(folder('inbox'), [1]);
  // Re-sight in trash: tombstone must remain (trashed mail stays hidden).
  store.upsertMessage(accountId, folder('trash'), 5, parsed, 'trash');
  let row = rawDb
    .select({ deletedAt: schema.messages.deletedAt })
    .from(schema.messages)
    .where(eq(schema.messages.id, r.id))
    .get();
  assert.notEqual(row?.deletedAt, null, 'trash re-sight keeps the tombstone');

  // Re-sight in inbox: clears the tombstone (undelete / move-race convergence).
  store.upsertMessage(accountId, folder('inbox'), 1, parsed, 'inbox');
  row = rawDb
    .select({ deletedAt: schema.messages.deletedAt })
    .from(schema.messages)
    .where(eq(schema.messages.id, r.id))
    .get();
  assert.equal(row?.deletedAt, null, 'non-trash re-sight un-tombstones');
});

test('relinkMessageToFolder replaces ALL mappings with the single destination', () => {
  const { accountId, folder } = seedAccount(['inbox', 'archive', 'trash']);
  const parsed = makeParsed({ gmMsgId: 'gm-move' });
  const r = store.upsertMessage(accountId, folder('inbox'), 1, parsed, 'inbox');
  store.upsertMessage(accountId, folder('archive'), 2, parsed, 'archive');

  store.relinkMessageToFolder(r.id, folder('trash'), 3);

  const links = rawDb
    .select({ folderId: schema.messageFolders.folderId, uid: schema.messageFolders.uid })
    .from(schema.messageFolders)
    .where(eq(schema.messageFolders.messageId, r.id))
    .all();
  assert.deepEqual(links, [{ folderId: folder('trash'), uid: 3 }]);
});

// ---------------------------------------------------------------------------
// Phase 5b — broaden direct store coverage beyond the Phase-1 net:
// attachment metadata, the source-path round-trip, the rebuild content rewrite
// (state preserved), and the UID-mapping read/clear helpers.
// ---------------------------------------------------------------------------

test('upsert persists attachment metadata rows alongside the inserted message', () => {
  const { accountId, folder } = seedAccount(['inbox']);
  const parsed = makeParsed({
    messageId: '<att@example.com>',
    attachments: [
      {
        filename: 'invoice.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 12_345,
        imapPartId: '2',
        partOrdinal: 1,
        contentId: null,
        isInline: false,
      },
      {
        filename: null,
        mimeType: 'image/png',
        sizeBytes: 64,
        imapPartId: '3',
        partOrdinal: 2,
        contentId: '<logo@cid>',
        isInline: true,
      },
    ],
  });

  const r = store.upsertMessage(accountId, folder('inbox'), 1, parsed, 'inbox');
  const rows = rawDb
    .select({
      filename: schema.attachments.filename,
      contentId: schema.attachments.contentId,
      isInline: schema.attachments.isInline,
      partOrdinal: schema.attachments.partOrdinal,
    })
    .from(schema.attachments)
    .where(eq(schema.attachments.messageId, r.id))
    .all();

  assert.equal(rows.length, 2);
  const pdf = rows.find((a) => a.filename === 'invoice.pdf');
  assert.equal(pdf?.isInline, false);
  const inline = rows.find((a) => a.contentId === '<logo@cid>');
  assert.equal(inline?.isInline, true);
  assert.equal(inline?.partOrdinal, 2);
});

test('setMessageSourcePath / sourcePathForMessage round-trip (null until set)', () => {
  const { accountId, folder } = seedAccount(['inbox']);
  const r = store.upsertMessage(
    accountId,
    folder('inbox'),
    1,
    makeParsed({ messageId: '<src@example.com>' }),
    'inbox',
  );

  assert.equal(store.sourcePathForMessage(r.id), null, 'body-only row has no source yet');

  const path = `/srv/${r.id}/source.eml`;
  store.setMessageSourcePath(r.id, path);
  assert.equal(store.sourcePathForMessage(r.id), path);
});

test('updateMessageContent rewrites derived columns but leaves flags + folder mapping intact', () => {
  const { accountId, folder } = seedAccount(['inbox']);
  const r = store.upsertMessage(
    accountId,
    folder('inbox'),
    7,
    makeParsed({
      messageId: '<rebuild@example.com>',
      subject: 'OLD subject',
      bodyText: 'OLD body',
      flags: { seen: true, flagged: true, answered: false, draft: false },
    }),
    'inbox',
  );

  store.updateMessageContent(r.id, {
    subject: 'NEW subject',
    fromName: 'Rebuilt Sender',
    fromAddress: 'rebuilt@example.com',
    to: [{ name: 'Bob', address: 'bob@example.com' }],
    cc: [],
    inReplyTo: null,
    references: null,
    sentAt: new Date('2025-01-02T03:04:05Z'),
    bodyText: 'NEW body',
    bodyHtml: '<p>NEW</p>',
    snippet: 'NEW snippet',
  });

  const row = rawDb
    .select({
      subject: schema.messages.subject,
      bodyText: schema.messages.bodyText,
      bodyHtml: schema.messages.bodyHtml,
      toAddresses: schema.messages.toAddresses,
      seen: schema.messages.seen,
      flagged: schema.messages.flagged,
    })
    .from(schema.messages)
    .where(eq(schema.messages.id, r.id))
    .get();

  assert.equal(row?.subject, 'NEW subject', 'content column rewritten');
  assert.equal(row?.bodyText, 'NEW body');
  assert.equal(row?.bodyHtml, '<p>NEW</p>');
  assert.equal(row?.toAddresses, JSON.stringify([{ name: 'Bob', address: 'bob@example.com' }]));
  assert.equal(row?.seen, true, 'mailbox state (flags) untouched by a content rebuild');
  assert.equal(row?.flagged, true);

  // Folder mapping (UID 7 in inbox) is not derived from RFC822, so it survives.
  assert.equal(store.messageIdForUid(folder('inbox'), 7), r.id);
});

test('knownUids / messageIdForUid reflect the folder mappings; clearFolderUids drops them all', () => {
  const { accountId, folder } = seedAccount(['inbox']);
  const a = store.upsertMessage(
    accountId,
    folder('inbox'),
    11,
    makeParsed({ messageId: '<a@example.com>' }),
    'inbox',
  );
  store.upsertMessage(
    accountId,
    folder('inbox'),
    22,
    makeParsed({ messageId: '<b@example.com>' }),
    'inbox',
  );

  assert.deepEqual(
    store.knownUids(folder('inbox')).sort((x, y) => x - y),
    [11, 22],
  );
  assert.equal(store.messageIdForUid(folder('inbox'), 11), a.id);
  assert.equal(store.messageIdForUid(folder('inbox'), 999), undefined, 'unknown UID → undefined');

  store.clearFolderUids(folder('inbox'));
  assert.deepEqual(store.knownUids(folder('inbox')), [], 'all UID mappings cleared');
  // The message rows themselves survive a UID-mapping clear (UIDVALIDITY rebuild).
  assert.ok(
    rawDb.select().from(schema.messages).where(eq(schema.messages.id, a.id)).get(),
    'clearing UID mappings does not delete the message row',
  );
});

test('updateMessageFlags writes the four IMAP flags onto the row', () => {
  const { accountId, folder } = seedAccount(['inbox']);
  const r = store.upsertMessage(
    accountId,
    folder('inbox'),
    1,
    makeParsed({ messageId: '<flags@example.com>' }),
    'inbox',
  );

  store.updateMessageFlags(r.id, { seen: true, flagged: true, answered: true, draft: false });
  const row = rawDb
    .select({
      seen: schema.messages.seen,
      flagged: schema.messages.flagged,
      answered: schema.messages.answered,
      draft: schema.messages.draft,
    })
    .from(schema.messages)
    .where(eq(schema.messages.id, r.id))
    .get();
  assert.deepEqual(row, { seen: true, flagged: true, answered: true, draft: false });
});
