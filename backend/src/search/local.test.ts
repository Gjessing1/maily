/**
 * IR → FTS5/SQL compiler coverage (ROADMAP §3.7.D). Exercises the new state and
 * attachment-filename predicates end-to-end against a real (throwaway) SQLite DB:
 * what `is:unread` / `is:flagged` / `filename:` actually return. Same bootstrap as
 * slices.test.ts: point MAILY_DATA_DIR at a temp dir BEFORE the dynamic import,
 * then run migrations so the FTS index + triggers exist.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before, beforeEach } from 'node:test';
import { eq } from 'drizzle-orm';
import type * as SchemaNS from '../db/schema.js';
import type * as DbClientNS from '../db/client.js';
import type * as LocalNS from './local.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'maily-search-test-'));
process.env.MAILY_DATA_DIR = tmpRoot;

let db: (typeof DbClientNS)['db'];
let schema: typeof SchemaNS;
let L: typeof LocalNS;

before(async () => {
  const client = await import('../db/client.js');
  const { runMigrations } = await import('../db/migrate.js');
  runMigrations();
  db = client.db;
  schema = await import('../db/schema.js');
  L = await import('./local.js');
});

after(() => rmSync(tmpRoot, { recursive: true, force: true }));

beforeEach(() => {
  db.delete(schema.attachments).run();
  db.delete(schema.messageFolders).run();
  db.delete(schema.folders).run();
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

function seedMessage(
  accountId: string,
  opts: {
    subject: string;
    bodyText?: string;
    seen?: boolean;
    flagged?: boolean;
    answered?: boolean;
  },
): string {
  const id = randomUUID();
  db.insert(schema.messages)
    .values({
      id,
      accountId,
      fromAddress: 'sender@x.example',
      subject: opts.subject,
      bodyText: opts.bodyText ?? 'hello body',
      receivedAt: new Date(),
      seen: opts.seen ?? false,
      flagged: opts.flagged ?? false,
      answered: opts.answered ?? false,
    })
    .run();
  return id;
}

test('is:unread / is:read split by seen state', () => {
  const acct = seedAccount();
  const unread = seedMessage(acct, { subject: 'fresh', seen: false });
  const read = seedMessage(acct, { subject: 'old news', seen: true });

  assert.deepEqual(
    L.searchLocal('is:unread', 10).map((m) => m.id),
    [unread],
  );
  assert.deepEqual(
    L.searchLocal('is:read', 10).map((m) => m.id),
    [read],
  );
});

test('is:flagged and is:answered filter by their flags', () => {
  const acct = seedAccount();
  const star = seedMessage(acct, { subject: 'starred', flagged: true });
  const replied = seedMessage(acct, { subject: 'replied', answered: true });
  seedMessage(acct, { subject: 'plain' });

  assert.deepEqual(
    L.searchLocal('is:flagged', 10).map((m) => m.id),
    [star],
  );
  assert.deepEqual(
    L.searchLocal('is:answered', 10).map((m) => m.id),
    [replied],
  );
});

test('state filters combine with free text via the FTS index', () => {
  const acct = seedAccount();
  const hit = seedMessage(acct, { subject: 'budget', bodyText: 'quarterly budget', seen: false });
  seedMessage(acct, { subject: 'budget', bodyText: 'quarterly budget', seen: true });

  assert.deepEqual(
    L.searchLocal('budget is:unread', 10).map((m) => m.id),
    [hit],
  );
});

test('in:trash finds tombstoned trash mail that normal search hides', () => {
  const acct = seedAccount();
  const trashed = seedMessage(acct, { subject: 'old invoice', bodyText: 'invoice from trash' });
  const kept = seedMessage(acct, { subject: 'new invoice', bodyText: 'invoice in inbox' });

  // Delete = tombstone + move into the trash-role folder (queries.ts §13 semantics).
  const folderId = randomUUID();
  db.insert(schema.folders)
    .values({ id: folderId, accountId: acct, path: 'Trash', name: 'Trash', role: 'trash' })
    .run();
  db.insert(schema.messageFolders).values({ messageId: trashed, folderId }).run();
  db.update(schema.messages)
    .set({ deletedAt: new Date() })
    .where(eq(schema.messages.id, trashed))
    .run();

  assert.deepEqual(
    L.searchLocal('invoice', 10).map((m) => m.id),
    [kept],
  );
  assert.deepEqual(
    L.searchLocal('invoice in:trash', 10).map((m) => m.id),
    [trashed],
  );
  // A purged shell stays hidden even in the trash scope.
  db.update(schema.messages)
    .set({ purgedAt: new Date() })
    .where(eq(schema.messages.id, trashed))
    .run();
  assert.deepEqual(L.searchLocal('invoice in:trash', 10), []);
});

test('filename: matches non-inline attachment names only', () => {
  const acct = seedAccount();
  const withPdf = seedMessage(acct, { subject: 'report attached' });
  db.insert(schema.attachments)
    .values({ messageId: withPdf, filename: 'Q2-report.pdf', isInline: false })
    .run();
  // Inline image with a matching name must NOT count.
  const inlineOnly = seedMessage(acct, { subject: 'logo mail' });
  db.insert(schema.attachments)
    .values({ messageId: inlineOnly, filename: 'report-logo.png', isInline: true })
    .run();

  assert.deepEqual(
    L.searchLocal('filename:report', 10).map((m) => m.id),
    [withPdf],
  );
});
