/**
 * Action Center proposal data-access coverage (ROADMAP Phase 4; ARCHITECTURE §15).
 * Pins the read/resolve contract the Action Center route depends on:
 *   - listing returns live offers newest-first with source-message context,
 *   - silent expiry flips past-horizon pending offers to `expired` (lazy, no cron),
 *   - offers on a tombstoned (deleted) source message are suppressed,
 *   - approve/dismiss are terminal + idempotent (a double-resolve is a no-op),
 *   - the count tracks the same live set the list does.
 *
 * Same bootstrap as pipeline.test.ts: point MAILY_DATA_DIR at a throwaway dir BEFORE
 * the dynamic import so the shared db/env pick it up.
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
import type * as ProposalsNS from './proposals.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'maily-proposals-test-'));
process.env.MAILY_DATA_DIR = tmpRoot;

let db: (typeof DbClientNS)['db'];
let schema: typeof SchemaNS;
let P: typeof ProposalsNS;

before(async () => {
  const client = await import('../db/client.js');
  const { runMigrations } = await import('../db/migrate.js');
  runMigrations();
  db = client.db;
  schema = await import('../db/schema.js');
  P = await import('./proposals.js');
});

after(() => rmSync(tmpRoot, { recursive: true, force: true }));

beforeEach(() => {
  db.delete(schema.proposals).run();
  db.delete(schema.messages).run();
  db.delete(schema.accounts).run();
});

function seedAccount(): string {
  const id = randomUUID();
  db.insert(schema.accounts)
    .values({
      id,
      email: `${id}@example.com`,
      provider: 'imap',
      imapHost: 'imap',
      smtpHost: 'smtp',
    })
    .run();
  return id;
}

function seedMessage(accountId: string, opts: { deletedAt?: Date | null } = {}): string {
  const id = randomUUID();
  db.insert(schema.messages)
    .values({
      id,
      accountId,
      subject: 'Trip to Oslo',
      fromName: 'Airline',
      fromAddress: 'noreply@airline.example',
      receivedAt: new Date('2026-06-01T10:00:00Z'),
      deletedAt: opts.deletedAt ?? null,
    })
    .run();
  return id;
}

function seedProposal(
  messageId: string,
  opts: {
    type?: string;
    status?: 'pending' | 'approved';
    expiresAt?: Date | null;
    createdAt?: Date;
  } = {},
): string {
  const id = randomUUID();
  db.insert(schema.proposals)
    .values({
      id,
      messageId,
      enricher: 'travel',
      type: opts.type ?? 'calendar_event',
      title: 'UA110 SFO→JFK',
      payload: JSON.stringify({ summary: 'UA110 SFO→JFK', start: '2026-07-01T08:00:00Z' }),
      status: opts.status ?? 'pending',
      expiresAt: opts.expiresAt ?? null,
      createdAt: opts.createdAt ?? new Date(),
    })
    .run();
  return id;
}

test('listPendingProposals: returns live offers newest-first with source context', () => {
  const acct = seedAccount();
  const msg = seedMessage(acct);
  const older = seedProposal(msg, { createdAt: new Date('2026-06-01T00:00:00Z') });
  const newer = seedProposal(msg, { createdAt: new Date('2026-06-02T00:00:00Z') });

  const list = P.listPendingProposals();
  assert.equal(list.length, 2);
  assert.equal(list[0]!.id, newer);
  assert.equal(list[1]!.id, older);
  // Source context joined + payload parsed back to an object.
  assert.equal(list[0]!.source?.subject, 'Trip to Oslo');
  assert.equal(list[0]!.source?.fromAddress, 'noreply@airline.example');
  assert.deepEqual((list[0]!.payload as { summary: string }).summary, 'UA110 SFO→JFK');
});

test('expireStaleProposals: past-horizon pending offers flip to expired and drop out', () => {
  const acct = seedAccount();
  const msg = seedMessage(acct);
  const stale = seedProposal(msg, { expiresAt: new Date('2026-01-01T00:00:00Z') });
  const live = seedProposal(msg, { expiresAt: new Date('2030-01-01T00:00:00Z') });

  const expired = P.expireStaleProposals(new Date('2026-06-07T00:00:00Z'));
  assert.equal(expired, 1);

  const list = P.listPendingProposals(new Date('2026-06-07T00:00:00Z'));
  assert.equal(list.length, 1);
  assert.equal(list[0]!.id, live);

  const staleRow = db.select().from(schema.proposals).where(eq(schema.proposals.id, stale)).get();
  assert.equal(staleRow!.status, 'expired');
  assert.ok(staleRow!.resolvedAt);
});

test('offers on a tombstoned source message are suppressed', () => {
  const acct = seedAccount();
  const live = seedMessage(acct);
  const trashed = seedMessage(acct, { deletedAt: new Date() });
  seedProposal(live);
  seedProposal(trashed);

  assert.equal(P.listPendingProposals().length, 1);
  assert.equal(P.pendingProposalCount(), 1);
  assert.equal(P.proposalsForMessage(trashed).length, 0);
});

test('approve/dismiss are terminal and idempotent', () => {
  const acct = seedAccount();
  const msg = seedMessage(acct);
  const a = seedProposal(msg);
  const b = seedProposal(msg);

  assert.equal(P.approveProposal(a), true);
  assert.equal(P.approveProposal(a), false); // already resolved → no-op
  assert.equal(P.dismissProposal(b), true);

  assert.equal(P.listPendingProposals().length, 0);
  assert.equal(P.pendingProposalCount(), 0);

  const aRow = db.select().from(schema.proposals).where(eq(schema.proposals.id, a)).get();
  assert.equal(aRow!.status, 'approved');
});
