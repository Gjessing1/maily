/**
 * The billing export feed (`billing-export.ts` + `GET /api/export/billing`): which ledger
 * rows it trusts, the forward-only cursor over `(updated_at, id)`, the settle window, and
 * the document list it builds from the attachments table.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before, beforeEach } from 'node:test';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type * as SchemaNS from '../db/schema.js';
import type * as DbClientNS from '../db/client.js';
import type * as ExportNS from './billing-export.js';
import type * as RegistryNS from './registry.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'maily-billing-export-test-'));
process.env.MAILY_DATA_DIR = tmpRoot;

let db: (typeof DbClientNS)['db'];
let schema: typeof SchemaNS;
let E: typeof ExportNS;
let R: typeof RegistryNS;
let app: FastifyInstance;
let account: string;

before(async () => {
  const client = await import('../db/client.js');
  const { runMigrations } = await import('../db/migrate.js');
  runMigrations();
  db = client.db;
  schema = await import('../db/schema.js');
  E = await import('./billing-export.js');
  R = await import('./registry.js');
  const { default: Fastify } = await import('fastify');
  const { exportRoutes } = await import('../routes/api/export.js');
  app = Fastify();
  await app.register(exportRoutes);
  await app.ready();
});

after(async () => {
  await app?.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  db.delete(schema.enrichments).run();
  db.delete(schema.attachments).run();
  db.delete(schema.messages).run();
  db.delete(schema.accounts).run();
  account = randomUUID();
  db.insert(schema.accounts)
    .values({ id: account, email: 'me@x.example', provider: 'imap', imapHost: 'i', smtpHost: 's' })
    .run();
});

const KID = '110000637677425';
// Every stamp below is long settled relative to the real clock.
const T0 = Date.UTC(2026, 0, 1);

function invoice(over: Record<string, unknown> = {}) {
  return {
    invoice: {
      kind: 'invoice',
      documents: [],
      kids: [],
      ibans: [],
      accounts: [],
      amount: null,
      dueDate: null,
      ...over,
    },
  };
}

interface SeedOpts {
  result: unknown;
  at?: number;
  version?: number;
  status?: 'ok' | 'dead';
  rowId?: string;
  message?: Partial<typeof SchemaNS.messages.$inferInsert>;
}

function seed(opts: SeedOpts): { messageId: string; rowId: string } {
  const messageId = randomUUID();
  const rowId = opts.rowId ?? randomUUID();
  db.insert(schema.messages)
    .values({
      id: messageId,
      accountId: account,
      subject: 'Faktura',
      fromName: 'Hafslund',
      fromAddress: 'faktura@hafslund.example',
      receivedAt: new Date(T0),
      ...opts.message,
    })
    .run();
  db.insert(schema.enrichments)
    .values({
      id: rowId,
      messageId,
      enricher: 'invoice',
      enricherVersion: opts.version ?? R.enricherByName('invoice')!.version,
      kind: 'search',
      status: opts.status ?? 'ok',
      result: typeof opts.result === 'string' ? opts.result : JSON.stringify(opts.result),
      updatedAt: new Date(opts.at ?? T0),
    })
    .run();
  return { messageId, rowId };
}

const page = (after: string | null = null, limit = 50) => E.billingExportPage({ after, limit });
const messageIds = (p: ReturnType<typeof page>) => p.items.map((i) => i.messageId);

test('exports trusted invoices and receipts only, oldest classification first', () => {
  const receipt = seed({ result: invoice({ kind: 'receipt' }), at: T0 + 2 });
  const bill = seed({ result: invoice({ kids: [KID] }), at: T0 + 1 });
  seed({ result: { invoice: null }, at: T0 + 3 });
  seed({ result: invoice(), at: T0 + 4, version: 0 });
  seed({ result: invoice(), at: T0 + 5, status: 'dead' });
  seed({ result: '{not json', at: T0 + 6 });
  seed({ result: { invoice: { kids: [KID], ibans: [], accounts: [] } }, at: T0 + 7 });

  const p = page();
  assert.deepEqual(messageIds(p), [bill.messageId, receipt.messageId]);
  assert.equal(p.hasMore, false);
  assert.deepEqual(
    p.items.map((i) => i.kind),
    ['invoice', 'receipt'],
  );
});

test('an item carries the message, its facts and its fetchable documents', () => {
  // Seeded first so the attachments below can reference the message.
  const { messageId, rowId } = seed({ result: invoice() });
  const attId = randomUUID();
  const strayId = randomUUID();
  const other = seed({ result: { invoice: null } });
  db.insert(schema.attachments)
    .values([
      { id: attId, messageId, filename: 'faktura.pdf', mimeType: 'application/pdf', sizeBytes: 42 },
      // Belongs to another message: not reachable through this message's route.
      { id: strayId, messageId: other.messageId, filename: 'x.pdf' },
    ])
    .run();
  db.update(schema.enrichments)
    .set({
      result: JSON.stringify(
        invoice({
          kids: [KID],
          amount: { value: 1234.5, currency: 'NOK', raw: 'kr 1 234,50' },
          dueDate: '2026-02-01',
          documents: [
            { attachmentId: attId, kind: 'invoice' },
            { attachmentId: strayId, kind: 'invoice' },
            { attachmentId: randomUUID(), kind: 'invoice' },
          ],
        }),
      ),
    })
    .where(eq(schema.enrichments.id, rowId))
    .run();

  const p = page();
  assert.equal(p.items.length, 1);
  const [item] = p.items;
  assert.deepEqual(item, {
    messageId,
    accountId: account,
    kind: 'invoice',
    subject: 'Faktura',
    from: { name: 'Hafslund', address: 'faktura@hafslund.example' },
    receivedAt: new Date(T0).toISOString(),
    classifiedAt: new Date(T0).toISOString(),
    documents: [
      {
        attachmentId: attId,
        kind: 'invoice',
        filename: 'faktura.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 42,
      },
    ],
    kids: [KID],
    accounts: [],
    ibans: [],
    amount: { value: 1234.5, currency: 'NOK' },
    dueDate: '2026-02-01',
  });
});

test('pages forward on (updated_at, id), breaking stamp ties by id', () => {
  // Three rows share a stamp; ids fix their order.
  const a = seed({ result: invoice(), rowId: '00000000-0000-4000-8000-00000000000a' });
  const b = seed({ result: invoice(), rowId: '00000000-0000-4000-8000-00000000000b' });
  const c = seed({ result: invoice(), rowId: '00000000-0000-4000-8000-00000000000c' });

  const first = page(null, 2);
  assert.deepEqual(messageIds(first), [a.messageId, b.messageId]);
  assert.equal(first.hasMore, true);
  assert.equal(first.cursor, `${T0}.${b.rowId}`);

  const second = page(first.cursor, 2);
  assert.deepEqual(messageIds(second), [c.messageId]);
  assert.equal(second.hasMore, false);

  // Nothing new: the cursor holds still rather than resetting.
  const third = page(second.cursor, 2);
  assert.deepEqual(third.items, []);
  assert.equal(third.cursor, second.cursor);
});

test('a re-classified message comes round again with its new facts', () => {
  const { messageId, rowId } = seed({ result: invoice() });
  const { cursor } = page();
  db.update(schema.enrichments)
    .set({ result: JSON.stringify(invoice({ kind: 'receipt' })), updatedAt: new Date(T0 + 60_000) })
    .run();
  const again = page(cursor);
  assert.deepEqual(messageIds(again), [messageId]);
  assert.equal(again.items[0]!.kind, 'receipt');
  assert.equal(again.cursor, `${T0 + 60_000}.${rowId}`);
});

test('a row newer than the settle window waits for the next poll', () => {
  const now = T0 + 1_000_000;
  seed({ result: invoice(), at: now - E.SETTLE_MS + 1 });
  assert.equal(E.billingExportPage({ after: null, limit: 10, now }).items.length, 0);
  assert.equal(E.billingExportPage({ after: null, limit: 10, now: now + 1 }).items.length, 1);
});

test('a trashed message is exported; a purged one has no bytes left and is not', () => {
  const trashed = seed({ result: invoice(), message: { deletedAt: new Date(T0) } });
  seed({ result: invoice(), message: { deletedAt: new Date(T0), purgedAt: new Date(T0) } });
  assert.deepEqual(messageIds(page()), [trashed.messageId]);
});

test('a row that fails the shape check is skipped, and the cursor still moves past it', () => {
  // Passes the SQL kind filter, fails readInvoice (kids is not a list).
  const bad = seed({ result: invoice({ kids: 'nope' }), at: T0 + 1 });
  const p = page();
  assert.deepEqual(p.items, []);
  assert.equal(p.cursor, `${T0 + 1}.${bad.rowId}`);
});

test('GET /api/export/billing validates the cursor and clamps the limit', async () => {
  seed({ result: invoice() });
  const bad = await app.inject({ method: 'GET', url: '/api/export/billing?after=nope' });
  assert.equal(bad.statusCode, 400);

  const ok = await app.inject({ method: 'GET', url: '/api/export/billing?limit=100000' });
  assert.equal(ok.statusCode, 200);
  const body = ok.json() as { items: unknown[]; cursor: string; hasMore: boolean };
  assert.equal(body.items.length, 1);
  assert.equal(body.hasMore, false);

  const resumed = await app.inject({
    method: 'GET',
    url: `/api/export/billing?after=${encodeURIComponent(body.cursor)}`,
  });
  assert.deepEqual((resumed.json() as { items: unknown[] }).items, []);
});
