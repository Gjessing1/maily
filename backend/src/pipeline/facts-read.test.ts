/**
 * The typed ledger read path (`facts-read.ts`) and its SQL twins. One fixture set is
 * checked through both sides — `messageFacts`/`isPayable` in JS and `is:invoice` /
 * `is:receipt` / `is:bill` / `has:kid` / `has:tracking` in SQL — so the rules can't
 * drift apart. Also pins the trust bar (ok + current version + valid JSON), the
 * http(s)-only tracking link, and the cleanup gate protecting an invoice or receipt
 * that no keyword catches.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before, beforeEach } from 'node:test';
import { sql } from 'drizzle-orm';
import type * as SchemaNS from '../db/schema.js';
import type * as DbClientNS from '../db/client.js';
import type * as FactsNS from './facts-read.js';
import type * as LocalNS from '../search/local.js';
import type * as SafetyNS from '../cleanup/safety.js';
import type * as RegistryNS from './registry.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'maily-facts-test-'));
process.env.MAILY_DATA_DIR = tmpRoot;

let db: (typeof DbClientNS)['db'];
let schema: typeof SchemaNS;
let F: typeof FactsNS;
let L: typeof LocalNS;
let S: typeof SafetyNS;
let R: typeof RegistryNS;
let account: string;

before(async () => {
  const client = await import('../db/client.js');
  const { runMigrations } = await import('../db/migrate.js');
  runMigrations();
  db = client.db;
  schema = await import('../db/schema.js');
  F = await import('./facts-read.js');
  L = await import('../search/local.js');
  S = await import('../cleanup/safety.js');
  R = await import('./registry.js');
});

after(() => rmSync(tmpRoot, { recursive: true, force: true }));

beforeEach(() => {
  db.delete(schema.enrichments).run();
  db.delete(schema.messages).run();
  db.delete(schema.accounts).run();
  account = randomUUID();
  db.insert(schema.accounts)
    .values({ id: account, email: 'me@x.example', provider: 'imap', imapHost: 'i', smtpHost: 's' })
    .run();
});

// Real checksum-valid identifiers (the enricher's validators accepted them).
const KID = '110000637677425';
const ACCOUNT = '6021.07.45583';

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

function seed(
  subject: string,
  rows: { enricher: string; result: unknown; version?: number; status?: 'ok' | 'dead' }[],
): string {
  const id = randomUUID();
  db.insert(schema.messages)
    .values({ id, accountId: account, subject, bodyText: 'hei', receivedAt: new Date() })
    .run();
  for (const r of rows) {
    db.insert(schema.enrichments)
      .values({
        messageId: id,
        enricher: r.enricher,
        enricherVersion: r.version ?? R.enricherByName(r.enricher)!.version,
        kind: 'search',
        status: r.status ?? 'ok',
        result: typeof r.result === 'string' ? r.result : JSON.stringify(r.result),
      })
      .run();
  }
  return id;
}

const ids = (q: string) =>
  L.searchLocal(q, 50)
    .map((m) => m.id)
    .sort();

test('JS and SQL agree on which messages are bills, carry a KID, or track a parcel', () => {
  const kidBill = seed('a', [{ enricher: 'invoice', result: invoice({ kids: [KID] }) }]);
  const accountBill = seed('b', [
    { enricher: 'invoice', result: invoice({ accounts: [ACCOUNT] }) },
  ]);
  const amountOnly = seed('c', [
    {
      enricher: 'invoice',
      result: invoice({ amount: { value: 1, currency: 'NOK', raw: '1 kr' } }),
    },
  ]);
  const nullInvoice = seed('d', [{ enricher: 'invoice', result: { invoice: null } }]);
  const stale = seed('e', [{ enricher: 'invoice', result: invoice({ kids: [KID] }), version: 0 }]);
  const dead = seed('f', [
    { enricher: 'invoice', result: invoice({ kids: [KID] }), status: 'dead' },
  ]);
  const garbage = seed('g', [{ enricher: 'invoice', result: '{not json' }]);
  // A paid receipt: its KID is history, not something to pay.
  const receipt = seed('r', [
    { enricher: 'invoice', result: invoice({ kind: 'receipt', kids: [KID] }) },
  ]);
  // A v1-shaped row (no kind) written under the current version is not trusted.
  const kindless = seed('k', [
    { enricher: 'invoice', result: { invoice: { kids: [KID], ibans: [], accounts: [] } } },
  ]);
  const parcel = seed('h', [
    {
      enricher: 'package',
      result: {
        shipments: [
          {
            carrier: 'UPS',
            trackingNumber: '1Z',
            trackingUrl: null,
            estimatedDelivery: null,
            source: 'regex',
          },
        ],
      },
    },
  ]);
  const all = [
    kidBill,
    accountBill,
    amountOnly,
    nullInvoice,
    stale,
    dead,
    garbage,
    receipt,
    kindless,
    parcel,
  ];

  const jsPayable = all.filter((id) => F.isPayable(F.messageFacts(id).invoice)).sort();
  assert.deepEqual(jsPayable, [kidBill, accountBill].sort());
  assert.deepEqual(ids('is:bill'), jsPayable);

  const kindOf = (id: string) => F.messageFacts(id).invoice?.kind;
  const jsInvoices = all.filter((id) => kindOf(id) === 'invoice').sort();
  assert.deepEqual(jsInvoices, [kidBill, accountBill, amountOnly].sort());
  assert.deepEqual(ids('is:invoice'), jsInvoices);
  const jsReceipts = all.filter((id) => kindOf(id) === 'receipt');
  assert.deepEqual(jsReceipts, [receipt]);
  assert.deepEqual(ids('is:receipt'), jsReceipts);

  const jsKid = all.filter((id) => (F.messageFacts(id).invoice?.kids.length ?? 0) > 0).sort();
  assert.deepEqual(jsKid, [kidBill, receipt].sort());
  assert.deepEqual(ids('has:kid'), jsKid);

  const jsTracking = all.filter((id) => F.messageFacts(id).shipments.length > 0);
  assert.deepEqual(jsTracking, [parcel]);
  assert.deepEqual(ids('has:tracking'), jsTracking);
});

test('the reader DTO shows payment details only for a bill, and only safe tracking links', () => {
  const paid = seed('p', [
    {
      enricher: 'invoice',
      result: invoice({
        kind: 'receipt',
        kids: [KID],
        documents: [{ attachmentId: 'att-1', kind: 'receipt' }],
      }),
    },
  ]);
  const paidDto = F.toMessageFactsDto(F.messageFacts(paid));
  assert.equal(paidDto.payment, null, 'a receipt has nothing left to pay');
  assert.equal(paidDto.billing, 'receipt');
  assert.deepEqual(paidDto.documents, [{ attachmentId: 'att-1', kind: 'receipt' }]);

  const amountOnly = seed('a', [
    {
      enricher: 'invoice',
      result: invoice({ amount: { value: 9, currency: 'NOK', raw: '9 kr' } }),
    },
  ]);
  assert.equal(F.toMessageFactsDto(F.messageFacts(amountOnly)).payment, null);

  const bill = seed('b', [
    {
      enricher: 'invoice',
      result: invoice({
        kids: [KID],
        amount: { value: 398, currency: 'NOK', raw: '398,00 kr' },
        dueDate: '2026-10-02',
      }),
    },
    {
      enricher: 'package',
      result: {
        shipments: [
          {
            carrier: 'X',
            trackingNumber: '1',
            trackingUrl: 'javascript:alert(1)',
            estimatedDelivery: null,
            source: 'jsonld',
          },
          {
            carrier: 'Y',
            trackingNumber: '2',
            trackingUrl: 'https://track.example/2',
            estimatedDelivery: null,
            source: 'regex',
          },
        ],
      },
    },
  ]);
  const dto = F.toMessageFactsDto(F.messageFacts(bill));
  assert.equal(dto.billing, 'invoice');
  assert.deepEqual(dto.payment, {
    kids: [KID],
    accounts: [],
    ibans: [],
    amount: { value: 398, currency: 'NOK' },
    dueDate: '2026-10-02',
  });
  assert.deepEqual(
    dto.shipments.map((s) => s.trackingUrl),
    [null, 'https://track.example/2'],
  );
});

test('the cleanup gate protects an invoice or receipt that carries no protected keyword', () => {
  const bill = seed('Hei', [{ enricher: 'invoice', result: invoice({ accounts: [ACCOUNT] }) }]);
  const receipt = seed('Hei', [{ enricher: 'invoice', result: invoice({ kind: 'receipt' }) }]);
  const plain = seed('Hei', []);
  const unprotected = (
    db.all(sql`SELECT m.id AS id FROM messages m WHERE ${S.notProtected('m')}`) as { id: string }[]
  ).map((r) => r.id);
  assert.ok(!unprotected.includes(bill));
  assert.ok(!unprotected.includes(receipt));
  assert.ok(unprotected.includes(plain));
});
