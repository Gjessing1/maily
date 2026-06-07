/**
 * Cleanup slice coverage (ROADMAP Phase 6). Pins the deterministic analytics contract:
 *  - storage audit groups every sender by estimated bytes (body + attachments),
 *  - never-replied excludes domains the user has written back to + protected mail,
 *  - cold-storage selects old, value-marker-free, non-protected mail,
 *  - the HARD safety filter keeps financial/security mail out of delete-eligible slices.
 *
 * Same bootstrap as proposals.test.ts: point MAILY_DATA_DIR at a throwaway dir BEFORE the
 * dynamic import so the shared db/env pick it up, then run migrations (creates the FTS5
 * index + triggers the slices depend on).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before, beforeEach } from 'node:test';
import type { CleanupSliceDto } from '@maily/shared';
import type * as SchemaNS from '../db/schema.js';
import type * as DbClientNS from '../db/client.js';
import type * as SlicesNS from './slices.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'maily-cleanup-test-'));
process.env.MAILY_DATA_DIR = tmpRoot;

let db: (typeof DbClientNS)['db'];
let schema: typeof SchemaNS;
let S: typeof SlicesNS;

const YEAR = 365.25 * 24 * 60 * 60 * 1000;

before(async () => {
  const client = await import('../db/client.js');
  const { runMigrations } = await import('../db/migrate.js');
  runMigrations();
  db = client.db;
  schema = await import('../db/schema.js');
  S = await import('./slices.js');
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

function seedFolder(accountId: string, role: 'inbox' | 'sent'): string {
  const id = randomUUID();
  db.insert(schema.folders).values({ id, accountId, path: role, name: role, role }).run();
  return id;
}

function seedMessage(
  accountId: string,
  opts: {
    fromAddress: string;
    subject?: string;
    bodyText?: string;
    receivedAt?: Date;
    toAddresses?: string;
    folderId?: string;
  },
): string {
  const id = randomUUID();
  db.insert(schema.messages)
    .values({
      id,
      accountId,
      fromAddress: opts.fromAddress,
      fromName: 'Sender',
      subject: opts.subject ?? 'Hi',
      bodyText: opts.bodyText ?? 'plain body',
      toAddresses: opts.toAddresses ?? null,
      receivedAt: opts.receivedAt ?? new Date(),
    })
    .run();
  if (opts.folderId) {
    db.insert(schema.messageFolders)
      .values({ messageId: id, folderId: opts.folderId, uid: 1 })
      .run();
  }
  return id;
}

function findGroup(slice: CleanupSliceDto, domain: string) {
  return slice.groups.find((g) => g.domain === domain);
}

test('storageByDomain: groups every domain and counts attachment + body bytes', () => {
  const acct = seedAccount();
  const m = seedMessage(acct, { fromAddress: 'a@promo.example', bodyText: 'hello world' });
  db.insert(schema.attachments).values({ messageId: m, sizeBytes: 1000 }).run();

  const slice = S.storageByDomain();
  const g = findGroup(slice, 'promo.example');
  assert.ok(g, 'promo.example present in storage audit');
  assert.equal(g!.messageCount, 1);
  // body 'hello world' (11) + attachment 1000.
  assert.equal(g!.bytes, 1011);
  assert.equal(slice.totalMessages, 1);
});

test('neverRepliedSenders: excludes replied-to domains and protected mail', () => {
  const acct = seedAccount();
  const inbox = seedFolder(acct, 'inbox');
  const sent = seedFolder(acct, 'sent');

  // Never replied, ordinary → candidate.
  seedMessage(acct, { fromAddress: 'news@promo.example', bodyText: 'newsletter', folderId: inbox });
  // Protected (invoice) → must be excluded even though never replied.
  seedMessage(acct, {
    fromAddress: 'billing@bank.example',
    bodyText: 'your invoice',
    folderId: inbox,
  });
  // Replied to (we sent mail to work.example) → excluded.
  seedMessage(acct, {
    fromAddress: 'colleague@work.example',
    bodyText: 'meeting',
    folderId: inbox,
  });
  // The Sent message establishing the reply relationship.
  seedMessage(acct, {
    fromAddress: `${acct}@me.example`,
    bodyText: 'reply',
    folderId: sent,
    toAddresses: JSON.stringify([{ name: 'Colleague', address: 'colleague@work.example' }]),
  });

  const slice = S.neverRepliedSenders();
  assert.ok(findGroup(slice, 'promo.example'), 'unreplied ordinary sender present');
  assert.equal(findGroup(slice, 'work.example'), undefined, 'replied-to domain excluded');
  assert.equal(findGroup(slice, 'bank.example'), undefined, 'protected mail excluded');
});

test('coldStorageCandidates: old non-protected value-free mail only', () => {
  const acct = seedAccount();
  const old = new Date(Date.now() - 3 * YEAR);
  const recent = new Date();

  seedMessage(acct, { fromAddress: 'old@promo.example', bodyText: 'sale', receivedAt: old });
  seedMessage(acct, { fromAddress: 'new@promo.example', bodyText: 'sale', receivedAt: recent });
  // Old but carries a value marker (invoice) → kept, not cold (and protected).
  seedMessage(acct, {
    fromAddress: 'billing@shop.example',
    bodyText: 'invoice 42',
    receivedAt: old,
  });
  // Old + protected (password) → excluded by safety filter.
  seedMessage(acct, {
    fromAddress: 'noreply@bank.example',
    bodyText: 'password reset',
    receivedAt: old,
  });

  const slice = S.coldStorageCandidates(2);
  assert.equal(slice.totalMessages, 1, 'only the one old, value-free, unprotected message');
  assert.ok(findGroup(slice, 'promo.example'));
  assert.equal(findGroup(slice, 'shop.example'), undefined, 'value-marker mail kept');
  assert.equal(findGroup(slice, 'bank.example'), undefined, 'protected mail excluded');
});

test('cleanupSummary: counts protected mail', () => {
  const acct = seedAccount();
  seedMessage(acct, { fromAddress: 'a@x.example', bodyText: 'invoice attached' });
  seedMessage(acct, { fromAddress: 'b@x.example', bodyText: 'just chatting' });

  const summary = S.cleanupSummary();
  assert.equal(summary.totalMessages, 2);
  assert.equal(summary.protectedMessages, 1);
});
