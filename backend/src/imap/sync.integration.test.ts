/**
 * End-to-end sync/parse integration net (Refactoring Phase 5a). The Phase-1
 * `sync.test.ts` pins the pure transform (`buildParsedMessage`); this pins the
 * I/O *orchestration* around it that needs a live connection — exactly the part
 * `sync.test.ts` flagged as out of scope: the fetch→download deadlock ordering,
 * the live full-source capture vs. the body-only bulk path, dedup-on-refetch, the
 * resumable full-source sweep's watermark, and the per-day byte-budget stop.
 *
 * Everything below the IMAP socket is REAL: the SQLite store + migrations, the
 * on-disk `.eml` archive (`storage/source.ts`), the byte budget (`budget.ts`), and
 * the mailparser-based body derivation. Only the ImapFlow connection is faked —
 * `FakeImap` serves `.eml` fixtures over the same `fetch`/`download`/`search`
 * surface the engine calls. So a fixture genuinely round-trips: FETCH → archive →
 * parse → persist → read back.
 *
 * `client.ts`/`env.ts` read MAILY_DATA_DIR at import, so it's set before the
 * dynamic import (same ordering trick as store.test.ts / migrate.test.ts).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test, { after, before, beforeEach } from 'node:test';
import { eq } from 'drizzle-orm';
import type { FolderRole } from '@maily/shared';
import type { Capabilities } from './connection.js';
import type { FolderRow } from './folders.js';
import type * as SyncNS from './sync.js';
import type * as FoldersNS from './folders.js';
import type * as SchemaNS from '../db/schema.js';
import type * as DbClientNS from '../db/client.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'maily-sync-int-'));
process.env.MAILY_DATA_DIR = tmpRoot;

let sync: typeof SyncNS;
let folders: typeof FoldersNS;
let schema: typeof SchemaNS;
let rawDb: (typeof DbClientNS)['db'];
let env: { dailyDownloadBudgetBytes: number };
let recordDownloadedBytes: (n: number) => void;

before(async () => {
  const client = await import('../db/client.js');
  const { runMigrations } = await import('../db/migrate.js');
  runMigrations();
  rawDb = client.db;
  schema = await import('../db/schema.js');
  folders = await import('./folders.js');
  sync = await import('./sync.js');
  env = (await import('../env.js')).env;
  recordDownloadedBytes = (await import('./budget.js')).recordDownloadedBytes;
});

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  // The byte budget is process-global (a single app_settings row), so a previous
  // test's exhaustion would bleed forward — reset it before each test.
  rawDb.delete(schema.appSettings).where(eq(schema.appSettings.key, 'download_budget')).run();
});

const CRLF = '\r\n';
const NON_GMAIL: Capabilities = { qresync: false, condstore: false, gmail: false };

/** A served message: the canonical `.eml`, the FETCH envelope/structure, the body parts. */
interface Fixture {
  uid: number;
  raw: string;
  envelope: Record<string, unknown>;
  bodyStructure: unknown;
  parts: Record<string, string>;
  flags: Set<string>;
  internalDate: Date;
}

/** A multipart/alternative message with threading headers and no attachments. */
function altFixture(uid: number, messageId: string, subject: string): Fixture {
  const plain = `Plain text of ${subject}.`;
  const html = `<p>HTML of ${subject}.</p>`;
  const raw = [
    `From: Alice Example <alice@example.com>`,
    `To: Bob <bob@example.com>`,
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`,
    `References: <root@example.com>`,
    `Date: Tue, 03 Jun 2025 10:15:00 +0000`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="ALT"`,
    ``,
    `--ALT`,
    `Content-Type: text/plain; charset="utf-8"`,
    ``,
    plain,
    ``,
    `--ALT`,
    `Content-Type: text/html; charset="utf-8"`,
    ``,
    html,
    ``,
    `--ALT--`,
    ``,
  ].join(CRLF);

  return {
    uid,
    raw,
    envelope: {
      from: [{ name: 'Alice Example', address: 'alice@example.com' }],
      to: [{ name: 'Bob', address: 'bob@example.com' }],
      cc: [],
      subject,
      messageId,
      date: new Date('2025-06-03T10:15:00Z'),
    },
    bodyStructure: {
      type: 'multipart/alternative',
      childNodes: [
        { type: 'text/plain', part: '1' },
        { type: 'text/html', part: '2' },
      ],
    },
    parts: { '1': plain, '2': html },
    flags: new Set<string>(['\\Seen']),
    internalDate: new Date('2025-06-03T10:15:05Z'),
  };
}

/** A multipart/mixed message: a text/plain body (part 1) + a PDF attachment (part 2). */
function attachmentFixture(uid: number, messageId: string): Fixture {
  const plain = 'See attached invoice.';
  const raw = [
    `From: Vendor <vendor@example.com>`,
    `To: Bob <bob@example.com>`,
    `Subject: Invoice`,
    `Message-ID: ${messageId}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="MIX"`,
    ``,
    `--MIX`,
    `Content-Type: text/plain; charset="utf-8"`,
    ``,
    plain,
    ``,
    `--MIX`,
    `Content-Type: application/pdf; name="invoice.pdf"`,
    `Content-Disposition: attachment; filename="invoice.pdf"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    Buffer.from('%PDF-1.4 fake').toString('base64'),
    ``,
    `--MIX--`,
    ``,
  ].join(CRLF);

  return {
    uid,
    raw,
    envelope: {
      from: [{ name: 'Vendor', address: 'vendor@example.com' }],
      to: [{ name: 'Bob', address: 'bob@example.com' }],
      cc: [],
      subject: 'Invoice',
      messageId,
      date: new Date('2025-06-03T11:00:00Z'),
    },
    bodyStructure: {
      type: 'multipart/mixed',
      childNodes: [
        { type: 'text/plain', part: '1' },
        {
          type: 'application/pdf',
          part: '2',
          disposition: 'attachment',
          dispositionParameters: { filename: 'invoice.pdf' },
          parameters: { name: 'invoice.pdf' },
          size: 9000,
        },
      ],
    },
    parts: { '1': plain },
    flags: new Set<string>(),
    internalDate: new Date('2025-06-03T11:00:05Z'),
  };
}

/** A minimal ImapFlow stand-in serving Fixtures over the engine's call surface. */
class FakeImap {
  private byUid = new Map<number, Fixture>();
  /** Records every download call so tests can assert the live/bulk byte sources. */
  downloads: { uid: number; part: string | undefined }[] = [];
  mailbox: { uidNext: number; path: string } | null = null;

  constructor(fixtures: Fixture[]) {
    for (const f of fixtures) this.byUid.set(f.uid, f);
    const maxUid = Math.max(0, ...fixtures.map((f) => f.uid));
    this.mailbox = { uidNext: maxUid + 1, path: 'INBOX' };
  }

  // Header bytes imapflow would return for the `headers: ['references']` projection.
  private headerBytes(f: Fixture): Buffer {
    const refs = /^References:.*$/im.exec(f.raw)?.[0] ?? '';
    return Buffer.from(refs ? `${refs}\r\n` : '');
  }

  async *fetch(uids: number[], _query: unknown, _opts: unknown): AsyncGenerator<unknown> {
    for (const uid of uids) {
      const f = this.byUid.get(uid);
      if (!f) continue;
      yield {
        uid: f.uid,
        envelope: f.envelope,
        bodyStructure: f.bodyStructure,
        internalDate: f.internalDate,
        flags: f.flags,
        headers: this.headerBytes(f),
        emailId: undefined,
        threadId: undefined,
      };
    }
  }

  async download(
    uid: string,
    part: string | undefined,
    _opts: unknown,
  ): Promise<{ content: Readable; meta: { charset: string } } | undefined> {
    const f = this.byUid.get(Number(uid));
    if (!f) return undefined;
    this.downloads.push({ uid: Number(uid), part });
    // undefined part ⇒ full RFC822 source (the live + sweep archive path).
    const body = part === undefined ? f.raw : (f.parts[part] ?? '');
    return { content: Readable.from([Buffer.from(body)]), meta: { charset: 'utf-8' } };
  }

  async search(_query: unknown, _opts: unknown): Promise<number[]> {
    return [...this.byUid.keys()].sort((a, b) => a - b);
  }

  async getMailboxLock(_path: string): Promise<{ release: () => void }> {
    return { release: () => {} };
  }
}

/** Seed an isolated account + a single inbox folder; returns ids + a fresh FolderRow reader. */
function seedInbox(): { accountId: string; folderId: string; reload: () => FolderRow } {
  const accountId = randomUUID();
  const folderId = randomUUID();
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
  rawDb
    .insert(schema.folders)
    .values({ id: folderId, accountId, path: 'INBOX', name: 'INBOX', role: 'inbox' as FolderRole })
    .run();
  return {
    accountId,
    folderId,
    reload: () => folders.getFolderById(folderId)!,
  };
}

function ctxFor(client: FakeImap, accountId: string): SyncNS.SyncContext {
  const log = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Parameters<
    typeof sync.syncContext
  >[2];
  return sync.syncContext(client as never, accountId, log, NON_GMAIL);
}

function messageRow(id: string) {
  return rawDb.select().from(schema.messages).where(eq(schema.messages.id, id)).get();
}

// ---------------------------------------------------------------------------
// Live path: full-source capture + parse
// ---------------------------------------------------------------------------

test('live fetchAndStore archives the full .eml, derives the body from it, and persists', async () => {
  const { accountId, reload } = seedInbox();
  const folder = reload();
  const fix = altFixture(101, '<live@example.com>', 'Quarterly report');
  const client = new FakeImap([fix]);

  const counts = await sync.fetchAndStore(ctxFor(client, accountId), folder, [101], 'live');

  assert.equal(counts.insertedIds.length, 1, 'one new message inserted');
  const row = messageRow(counts.insertedIds[0]!)!;

  // Body came from parsing the archived .eml, not a part download.
  assert.match(row.bodyText ?? '', /Plain text of Quarterly report/);
  assert.match(row.bodyHtml ?? '', /HTML of Quarterly report/);
  assert.equal(row.subject, 'Quarterly report');

  // Source archived to disk and recorded on the row.
  assert.ok(row.sourcePath, 'source_path set on the row');
  assert.ok(existsSync(row.sourcePath!), 'the .eml exists on disk');
  assert.match(readFileSync(row.sourcePath!, 'utf-8'), /Message-ID: <live@example.com>/);

  // Live path pulls full source (part === undefined), never individual body parts.
  assert.deepEqual(
    client.downloads.map((d) => d.part),
    [undefined],
    'exactly one full-source download, no part downloads',
  );
});

// ---------------------------------------------------------------------------
// Bulk path: body-only, no source archive
// ---------------------------------------------------------------------------

test('bulk fetchAndStore downloads only the text parts and leaves source_path null', async () => {
  const { accountId, reload } = seedInbox();
  const folder = reload();
  const fix = altFixture(201, '<bulk@example.com>', 'Body only');
  const client = new FakeImap([fix]);

  const counts = await sync.fetchAndStore(ctxFor(client, accountId), folder, [201], 'bulk');
  const row = messageRow(counts.insertedIds[0]!)!;

  assert.equal(row.sourcePath, null, 'bulk path archives no source');
  assert.equal(row.bodyText, 'Plain text of Body only.', 'body came from the downloaded text part');
  // Downloads were the two text parts (1 + 2), never the full source.
  assert.deepEqual(
    client.downloads.map((d) => d.part).sort(),
    ['1', '2'],
    'plain + html parts downloaded, no full-source pull',
  );
});

test('bulk path enumerates attachment metadata from BODYSTRUCTURE without fetching bytes', async () => {
  const { accountId, reload } = seedInbox();
  const folder = reload();
  const fix = attachmentFixture(202, '<att@example.com>');
  const client = new FakeImap([fix]);

  const counts = await sync.fetchAndStore(ctxFor(client, accountId), folder, [202], 'bulk');
  const id = counts.insertedIds[0]!;

  const atts = rawDb
    .select()
    .from(schema.attachments)
    .where(eq(schema.attachments.messageId, id))
    .all();
  assert.equal(atts.length, 1);
  assert.equal(atts[0]!.filename, 'invoice.pdf');
  assert.equal(atts[0]!.imapPartId, '2');
  // Only the text part was downloaded — the PDF part's bytes were never fetched.
  assert.deepEqual(
    client.downloads.map((d) => d.part),
    ['1'],
    'attachment bytes are NOT eager-fetched during sync (ARCHITECTURE §4)',
  );
});

// ---------------------------------------------------------------------------
// Dedup on re-fetch
// ---------------------------------------------------------------------------

test('re-fetching the same UID dedups: second pass is an update, no second body download', async () => {
  const { accountId, reload } = seedInbox();
  const folder = reload();
  const fix = altFixture(301, '<dedup@example.com>', 'Once');
  const client = new FakeImap([fix]);
  const ctx = ctxFor(client, accountId);

  const first = await sync.fetchAndStore(ctx, folder, [301], 'bulk');
  const downloadsAfterFirst = client.downloads.length;

  const second = await sync.fetchAndStore(ctx, folder, [301], 'bulk');

  assert.equal(first.insertedIds.length, 1);
  assert.equal(second.insertedIds.length, 0, 'no new insert on the re-sighting');
  assert.equal(second.updated, 1, 'counted as an update');
  assert.equal(
    client.downloads.length,
    downloadsAfterFirst,
    'dedup short-circuits before any body re-download',
  );
});

// ---------------------------------------------------------------------------
// Full-source sweep
// ---------------------------------------------------------------------------

test('sweep upgrades an existing body-only row in place and advances the watermark to 1', async () => {
  const { accountId, folderId, reload } = seedInbox();
  let folder = reload();
  const fix = altFixture(401, '<sweep-upgrade@example.com>', 'Upgrade me');
  const client = new FakeImap([fix]);
  const ctx = ctxFor(client, accountId);

  // Bulk-sync first → a body-only row with no source.
  const bulk = await sync.fetchAndStore(ctx, folder, [401], 'bulk');
  const id = bulk.insertedIds[0]!;
  assert.equal(messageRow(id)!.sourcePath, null);

  // The sweep only runs on a first-synced folder (uid_validity set).
  folders.updateFolderSyncState(folderId, { uidValidity: 1, lastUid: 401 });
  folder = reload();

  const result = await sync.sweepFolderSource(ctx, folder);

  assert.equal(result.archived, 1, 'the existing row was upgraded');
  assert.equal(result.inserted, 0);
  assert.equal(result.done, true, 'swept to the bottom of the folder');
  const row = messageRow(id)!;
  assert.ok(row.sourcePath && existsSync(row.sourcePath), 'source now archived on disk');
  assert.equal(reload().oldestSyncedUid, 1, 'watermark advanced to the folder bottom');
});

test('sweep inserts a pre-window message (no existing row) with full source', async () => {
  const { accountId, folderId, reload } = seedInbox();
  const fix = altFixture(402, '<sweep-insert@example.com>', 'Ancient mail');
  const client = new FakeImap([fix]);
  const ctx = ctxFor(client, accountId);

  folders.updateFolderSyncState(folderId, { uidValidity: 1, lastUid: 500 });
  const result = await sync.sweepFolderSource(ctx, reload());

  assert.equal(result.inserted, 1, 'message older than the cache window inserted by the sweep');
  assert.equal(result.archived, 0);
  const inserted = rawDb
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.messageId, '<sweep-insert@example.com>'))
    .get()!;
  assert.ok(inserted.sourcePath && existsSync(inserted.sourcePath));
});

// ---------------------------------------------------------------------------
// Byte-budget stop (the throttle authority, budget.ts)
// ---------------------------------------------------------------------------

test('an exhausted budget makes the live path fall back to body-only (message not lost)', async () => {
  const { accountId, reload } = seedInbox();
  const folder = reload();
  const fix = altFixture(501, '<budget-live@example.com>', 'Over budget');
  const client = new FakeImap([fix]);

  // Spend the whole day's budget so canDownloadSource() is false.
  recordDownloadedBytes(env.dailyDownloadBudgetBytes);

  const counts = await sync.fetchAndStore(ctxFor(client, accountId), folder, [501], 'live');
  const row = messageRow(counts.insertedIds[0]!)!;

  assert.equal(counts.insertedIds.length, 1, 'the message is still stored');
  assert.equal(row.sourcePath, null, 'no source archived — budget exhausted');
  // It fell back to the body-only part downloads instead of a full-source pull.
  assert.deepEqual(client.downloads.map((d) => d.part).sort(), ['1', '2']);
});

test('an exhausted budget stops the sweep immediately with budgetExhausted', async () => {
  const { accountId, folderId, reload } = seedInbox();
  const fix = altFixture(502, '<budget-sweep@example.com>', 'No budget');
  const client = new FakeImap([fix]);
  folders.updateFolderSyncState(folderId, { uidValidity: 1, lastUid: 502 });

  recordDownloadedBytes(env.dailyDownloadBudgetBytes);

  const result = await sync.sweepFolderSource(ctxFor(client, accountId), reload());

  assert.equal(result.budgetExhausted, true);
  assert.equal(result.archived, 0);
  assert.equal(result.inserted, 0);
  assert.equal(result.done, false, 'sweep did not complete — it stopped on the budget');
});
