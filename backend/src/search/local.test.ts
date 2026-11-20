/**
 * Exercise search ranking and filters against a throwaway SQLite database with
 * the same FTS index and triggers as the API.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before, beforeEach } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import type * as SchemaNS from '../db/schema.js';
import type * as DbClientNS from '../db/client.js';
import type * as LocalNS from './local.js';
import type * as BackfillNS from './body-backfill.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'maily-search-test-'));
process.env.MAILY_DATA_DIR = tmpRoot;

let db: (typeof DbClientNS)['db'];
let schema: typeof SchemaNS;
let L: typeof LocalNS;
let backfillHtmlBodies: typeof BackfillNS.backfillHtmlBodies;

before(async () => {
  const client = await import('../db/client.js');
  const { runMigrations } = await import('../db/migrate.js');
  runMigrations();
  db = client.db;
  schema = await import('../db/schema.js');
  L = await import('./local.js');
  ({ backfillHtmlBodies } = await import('./body-backfill.js'));
});

after(() => rmSync(tmpRoot, { recursive: true, force: true }));

beforeEach(() => {
  db.delete(schema.appSettings).run();
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
    bodyText?: string | null;
    bodyHtml?: string;
    snippet?: string;
    fromName?: string;
    fromAddress?: string;
    toAddresses?: string | null;
    ccAddresses?: string | null;
    receivedAt?: Date | null;
    sentAt?: Date;
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
      fromName: opts.fromName,
      fromAddress: opts.fromAddress ?? 'sender@x.example',
      toAddresses: opts.toAddresses ?? null,
      ccAddresses: opts.ccAddresses ?? null,
      subject: opts.subject,
      bodyText: opts.bodyText === undefined ? 'hello body' : opts.bodyText,
      bodyHtml: opts.bodyHtml,
      snippet: opts.snippet,
      receivedAt: opts.receivedAt === undefined ? new Date() : opts.receivedAt,
      sentAt: opts.sentAt,
      seen: opts.seen ?? false,
      flagged: opts.flagged ?? false,
      answered: opts.answered ?? false,
    })
    .run();
  return id;
}

test('strong subject and sender matches outrank incidental mentions in newer mail', () => {
  const acct = seedAccount();
  const oldDate = new Date(Date.now() - 730 * 86_400_000);
  const subject = seedMessage(acct, { subject: 'Pension renewal', receivedAt: oldDate });
  const sender = seedMessage(acct, {
    subject: 'Annual notice',
    fromName: 'Pension renewal',
    receivedAt: oldDate,
  });
  const body = seedMessage(acct, {
    subject: 'News digest',
    bodyText: 'Pension renewal',
    flagged: true,
  });

  assert.deepEqual(
    L.searchLocal('pension renewal', 10).map((m) => m.id),
    [subject, sender, body],
  );
});

test('exact wording ranks first while prefix and out-of-order matches remain searchable', () => {
  const acct = seedAccount();
  const receivedAt = new Date();
  const reversed = seedMessage(acct, { subject: 'Budget quarterly', receivedAt });
  const prefix = seedMessage(acct, { subject: 'Quarterly budgeting', receivedAt });
  const exact = seedMessage(acct, { subject: 'Quarterly budget', receivedAt });
  seedMessage(acct, { subject: 'Annual budget', receivedAt });

  const [first, ...rest] = L.searchLocal('quarterly budget', 10).map((m) => m.id);
  assert.equal(first, exact);
  assert.deepEqual(rest.sort(), [prefix, reversed].sort());
});

test('recent matches participate in ranking before the result limit', () => {
  const acct = seedAccount();
  const oldDate = new Date(Date.now() - 30 * 86_400_000);
  for (let i = 0; i < 12; i++) seedMessage(acct, { subject: 'Milk delivery', receivedAt: oldDate });
  const recent = seedMessage(acct, { subject: 'Milk delivery' });

  assert.deepEqual(
    L.searchLocal('delivery', 1).map((m) => m.id),
    [recent],
  );
});

test('a sent date can rank matches with no received date and stars break keyword ties', () => {
  const acct = seedAccount();
  const sentAt = new Date();
  const undated = seedMessage(acct, { subject: 'Flight booking', receivedAt: null });
  const dated = seedMessage(acct, { subject: 'Flight booking', receivedAt: null, sentAt });
  const starred = seedMessage(acct, {
    subject: 'Flight booking',
    receivedAt: sentAt,
    flagged: true,
  });

  assert.deepEqual(
    L.searchLocal('booking', 10).map((m) => m.id),
    [starred, dated, undated],
  );
});

test('finds text beyond the preview in plain text, HTML-only and multipart mail', () => {
  const acct = seedAccount();
  const intro = 'Opening paragraph. '.repeat(24);
  const plain = seedMessage(acct, {
    subject: 'Plain message',
    bodyText: `${intro}Blueprint number 5184`,
    snippet: intro.slice(0, 200),
  });
  const html = seedMessage(acct, {
    subject: 'HTML message',
    bodyText: null,
    bodyHtml: `<p>${intro}</p><p>Ferry <b>confirmation</b></p><div hidden>hiddenword</div>`,
    snippet: intro.slice(0, 200),
  });
  const multipart = seedMessage(acct, {
    subject: 'Reservation',
    bodyText: 'Please check your itinerary',
    bodyHtml: `<p>${intro}</p><p>Check-in code: kapok</p>`,
    snippet: intro.slice(0, 200),
  });

  assert.deepEqual(
    L.searchLocal('blueprint 5184', 10).map((m) => m.id),
    [plain],
  );
  assert.deepEqual(
    L.searchLocal('ferry confirmation', 10).map((m) => m.id),
    [html],
  );
  assert.deepEqual(
    L.searchLocal('reservation kapok itinerary', 10).map((m) => m.id),
    [multipart],
  );
  assert.deepEqual(L.searchLocal('hiddenword', 10), []);

  db.update(schema.messages)
    .set({ bodyHtml: '<p>Revised passage</p>' })
    .where(eq(schema.messages.id, html))
    .run();
  assert.deepEqual(L.searchLocal('ferry confirmation', 10), []);
  assert.deepEqual(
    L.searchLocal('revised passage', 10).map((m) => m.id),
    [html],
  );
});

test('backfills HTML for mail already cached', async () => {
  const acct = seedAccount();
  const legacy = seedMessage(acct, { subject: 'Older mail', bodyHtml: '<p>Legacy passcode</p>' });
  // Migration seeds the existing fields and leaves html_body unset for the backfill.
  db.run(sql`UPDATE messages_fts SET html_body = NULL WHERE message_id = ${legacy}`);
  assert.deepEqual(L.searchLocal('legacy passcode', 10), []);

  assert.equal(await backfillHtmlBodies(), 1);
  assert.deepEqual(
    L.searchLocal('legacy passcode', 10).map((m) => m.id),
    [legacy],
  );
  assert.equal(await backfillHtmlBodies(), 0);
});

test('contact: finds direct received and sent mail but excludes unrelated CC traffic', () => {
  const acct = seedAccount();
  const ownAddress = db
    .select({ email: schema.accounts.email })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, acct))
    .get()!.email;
  const received = seedMessage(acct, {
    subject: 'received from contact',
    fromAddress: 'Person@Example.com',
    receivedAt: new Date('2025-01-01T00:00:00Z'),
  });
  const sent = seedMessage(acct, {
    subject: 'sent to contact',
    fromAddress: ownAddress,
    toAddresses: JSON.stringify([{ name: null, address: 'person@example.com' }]),
    receivedAt: new Date('2025-01-02T00:00:00Z'),
  });
  seedMessage(acct, {
    subject: 'third party copied contact',
    fromAddress: 'other@example.com',
    ccAddresses: JSON.stringify([{ name: null, address: 'person@example.com' }]),
  });

  assert.deepEqual(
    L.searchLocal('contact:person@example.com', 10).map((m) => m.id),
    [sent, received],
  );
});

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
