/**
 * Enrichment-pipeline framework coverage (ROADMAP Phase 4; ARCHITECTURE §14/§15).
 *
 * Pins the framework's load-bearing behaviour around the (deliberately trivial)
 * reference enricher and purpose-built test enrichers:
 *   - age-tiering + the operational-suppression rule (a backfill must never fire
 *     operational side effects on old mail),
 *   - the SQLite-backed pull/claim queue: enqueue (idempotent), self-heal backfill,
 *     claim → run → persist, retry-with-backoff → dead-letter,
 *   - proposals as a rebuildable projection (re-runs replace UN-ACTED offers but
 *     never clobber ones the user already approved),
 *   - reindex / version-bump reset paths (the §15 "drop and rebuild" contract).
 *
 * Every pipeline module reaches for the shared `db`/`env` at import, so we point
 * MAILY_DATA_DIR at a throwaway dir (and pin the two pipeline knobs) BEFORE the
 * dynamic import, mirroring store.test.ts / migrate.test.ts. The registry is a
 * module-level singleton; beforeEach/afterEach snapshot + restore it so a test can
 * freely swap in throwing/operational enrichers without leaking into the next.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before, beforeEach, afterEach } from 'node:test';
import { eq } from 'drizzle-orm';
import type * as SchemaNS from '../db/schema.js';
import type * as DbClientNS from '../db/client.js';
import type * as PipelineNS from './index.js';
import type { Enricher, PipelineMessage } from './types.js';

// Must be set before the db client (transitively, env.ts) is imported.
const tmpRoot = mkdtempSync(join(tmpdir(), 'maily-pipeline-test-'));
process.env.MAILY_DATA_DIR = tmpRoot;
process.env.MAILY_PIPELINE_HORIZON_DAYS = '30';
process.env.MAILY_PIPELINE_MAX_ATTEMPTS = '3';

const HORIZON_DAYS = 30;
const MAX_ATTEMPTS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

// Resolved in before() via dynamic import so the env var above wins.
let db: (typeof DbClientNS)['db'];
let schema: typeof SchemaNS;
let P: typeof PipelineNS;

before(async () => {
  const client = await import('../db/client.js');
  const { runMigrations } = await import('../db/migrate.js');
  runMigrations();
  db = client.db;
  schema = await import('../db/schema.js');
  P = await import('./index.js');
});

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// Registry is a singleton AND the DB is shared across the file, so isolate both per
// test: snapshot/restore the pristine enricher set, and truncate the pipeline tables.
// Several pipeline ops are intentionally global (reindex-by-enricher, queueDepth,
// self-heal backfill), so a clean slate is what makes their counts deterministic.
let registrySnapshot: Enricher[];
beforeEach(() => {
  registrySnapshot = P.allEnrichers();
  // FK cascade from messages clears enrichments + proposals; clear all then accounts.
  db.delete(schema.proposals).run();
  db.delete(schema.enrichments).run();
  db.delete(schema.messages).run();
  db.delete(schema.accounts).run();
});
afterEach(() => {
  for (const e of P.allEnrichers()) P.unregisterEnricher(e.name);
  for (const e of registrySnapshot) P.registerEnricher(e);
});

/** Replace the whole registry with exactly the given enrichers (test isolation). */
function only(...enrichers: Enricher[]): void {
  for (const e of P.allEnrichers()) P.unregisterEnricher(e.name);
  for (const e of enrichers) P.registerEnricher(e);
}

// --- Seeding ----------------------------------------------------------------------------

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

interface SeedMsgOpts {
  receivedAt?: Date | null;
  fromAddress?: string | null;
  bodyHtml?: string | null;
  toAddresses?: string | null;
  ccAddresses?: string | null;
  deletedAt?: Date | null;
}

function seedMessage(accountId: string, opts: SeedMsgOpts = {}): string {
  const id = randomUUID();
  db.insert(schema.messages)
    .values({
      id,
      accountId,
      subject: 'Subject',
      fromName: 'Sender',
      fromAddress: opts.fromAddress === undefined ? 'sender@example.com' : opts.fromAddress,
      toAddresses:
        opts.toAddresses === undefined
          ? JSON.stringify([{ name: null, address: 'a@x.com' }])
          : opts.toAddresses,
      ccAddresses: opts.ccAddresses ?? null,
      bodyText: 'body',
      bodyHtml: opts.bodyHtml === undefined ? '<p>body</p>' : opts.bodyHtml,
      receivedAt: opts.receivedAt === undefined ? new Date() : opts.receivedAt,
      deletedAt: opts.deletedAt ?? null,
    })
    .run();
  return id;
}

/** All enrichment rows for a message, as plain objects. */
function rowsFor(messageId: string): (typeof SchemaNS.enrichments.$inferSelect)[] {
  return db
    .select()
    .from(schema.enrichments)
    .where(eq(schema.enrichments.messageId, messageId))
    .all();
}

function oneRow(messageId: string, enricher: string): typeof SchemaNS.enrichments.$inferSelect {
  const row = rowsFor(messageId).find((r) => r.enricher === enricher);
  assert.ok(row, `expected an enrichment row for ${enricher}`);
  return row;
}

// Test enrichers ---------------------------------------------------------------

/** A search enricher that always succeeds with a fixed result. */
const okEnricher: Enricher = {
  name: 'test-ok',
  version: 1,
  kind: 'search',
  run: () => ({ result: { tag: 'ok' } }),
};

/** An operational enricher (suppressed on old mail). */
const opEnricher: Enricher = {
  name: 'test-op',
  version: 1,
  kind: 'operational',
  run: () => ({ result: { side: 'effect' } }),
};

/** An enricher that always throws (drives the failure / dead-letter path). */
const boomEnricher: Enricher = {
  name: 'test-boom',
  version: 1,
  kind: 'search',
  run: () => {
    throw new Error('boom');
  },
};

// ========================================================================================
// tiers — age-tiering drives operational suppression
// ========================================================================================

test('tierForMessage: recent mail is Tier 0', () => {
  assert.equal(P.tierForMessage(new Date()), 0);
});

test('tierForMessage: the horizon boundary is inclusive (Tier 0)', () => {
  const now = new Date();
  const atHorizon = new Date(now.getTime() - HORIZON_DAYS * DAY_MS);
  assert.equal(P.tierForMessage(atHorizon, now), 0);
});

test('tierForMessage: mail older than the horizon is Tier 1', () => {
  const now = new Date();
  const old = new Date(now.getTime() - (HORIZON_DAYS + 1) * DAY_MS);
  assert.equal(P.tierForMessage(old, now), 1);
});

test('tierForMessage: undated mail is conservatively Tier 1', () => {
  assert.equal(P.tierForMessage(null), 1);
});

// ========================================================================================
// registry — default registration + tier filtering
// ========================================================================================

test('the reference `facts` enricher self-registers by default', () => {
  const facts = P.enricherByName('facts');
  assert.ok(facts, 'facts enricher is registered');
  assert.equal(facts.kind, 'search');
});

test('register/unregister round-trips by name', () => {
  only();
  assert.equal(P.allEnrichers().length, 0);
  P.registerEnricher(okEnricher);
  assert.equal(P.enricherByName('test-ok')?.name, 'test-ok');
  P.unregisterEnricher('test-ok');
  assert.equal(P.enricherByName('test-ok'), undefined);
});

test('enrichersForTier suppresses operational enrichers on Tier 1, keeps them on Tier 0', () => {
  only(okEnricher, opEnricher);
  const tier0 = P.enrichersForTier(0)
    .map((e) => e.name)
    .sort();
  const tier1 = P.enrichersForTier(1)
    .map((e) => e.name)
    .sort();
  assert.deepEqual(tier0, ['test-ok', 'test-op']);
  assert.deepEqual(tier1, ['test-ok'], 'operational dropped on older mail');
});

// ========================================================================================
// enqueue — idempotent pending-row creation + self-heal backfill
// ========================================================================================

test('enqueueMessage inserts one pending row per tier-eligible enricher', () => {
  only(okEnricher, opEnricher);
  const acct = seedAccount();
  const msg = seedMessage(acct, { receivedAt: new Date() });

  const inserted = P.enqueueMessage(msg, new Date());
  assert.equal(inserted, 2);
  const rows = rowsFor(msg);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.status === 'pending'));
  assert.ok(rows.every((r) => r.attempts === 0));
});

test('enqueueMessage is idempotent (re-enqueue inserts nothing)', () => {
  only(okEnricher);
  const acct = seedAccount();
  const msg = seedMessage(acct);

  assert.equal(P.enqueueMessage(msg, new Date()), 1);
  assert.equal(P.enqueueMessage(msg, new Date()), 0, 'second enqueue is a no-op');
  assert.equal(rowsFor(msg).length, 1);
});

test('enqueueMessage on OLD mail skips operational enrichers (no stale side effects)', () => {
  only(okEnricher, opEnricher);
  const acct = seedAccount();
  const now = new Date();
  const old = new Date(now.getTime() - (HORIZON_DAYS + 5) * DAY_MS);
  const msg = seedMessage(acct, { receivedAt: old });

  P.enqueueMessage(msg, old, now);
  const names = rowsFor(msg).map((r) => r.enricher);
  assert.deepEqual(names, ['test-ok'], 'only the search enricher was queued');
});

test('backfillPending enqueues orphan messages, skips ones already enqueued and deleted ones', () => {
  only(okEnricher);
  const acct = seedAccount();
  const orphan = seedMessage(acct, { receivedAt: new Date() });
  const already = seedMessage(acct, { receivedAt: new Date() });
  const deleted = seedMessage(acct, { receivedAt: new Date(), deletedAt: new Date() });

  P.enqueueMessage(already, new Date()); // already has a row

  const enqueued = P.backfillPending(100);
  assert.equal(enqueued, 1, 'only the orphan was backfilled');
  assert.equal(rowsFor(orphan).length, 1);
  assert.equal(rowsFor(deleted).length, 0, 'soft-deleted mail is not enqueued');
});

// ========================================================================================
// runner — claim → run → persist
// ========================================================================================

test('drainPipeline runs a pending row to ok and persists the result JSON', async () => {
  only(okEnricher);
  const acct = seedAccount();
  const msg = seedMessage(acct);
  P.enqueueMessage(msg, new Date());

  const res = await P.drainPipeline({ selfHeal: false });
  assert.equal(res.claimed, 1);
  assert.equal(res.ok, 1);

  const row = oneRow(msg, 'test-ok');
  assert.equal(row.status, 'ok');
  assert.deepEqual(JSON.parse(row.result!), { tag: 'ok' });
  assert.equal(row.error, null);
  assert.ok(typeof row.durationMs === 'number');
});

test('the reference `facts` enricher extracts sender domain / html / recipient count', async () => {
  only(P.enricherByName('facts')!);
  const acct = seedAccount();
  const msg = seedMessage(acct, {
    fromAddress: 'alice@Example.COM',
    bodyHtml: '<p>hi</p>',
    toAddresses: JSON.stringify([{ name: null, address: 'a@x.com' }]),
    ccAddresses: JSON.stringify([{ name: null, address: 'b@x.com' }]),
  });
  P.enqueueMessage(msg, new Date());

  await P.drainPipeline({ selfHeal: false });
  const row = oneRow(msg, 'facts');
  assert.deepEqual(JSON.parse(row.result!), {
    senderDomain: 'example.com',
    hasHtmlBody: true,
    recipientCount: 2,
  });
});

test('an enricher whose applies() declines is recorded as a no-op success (not retried)', async () => {
  const gated: Enricher = {
    name: 'test-gated',
    version: 1,
    kind: 'search',
    applies: (m: PipelineMessage) => m.fromAddress === 'wanted@x.com',
    run: () => ({ result: { ran: true } }),
  };
  only(gated);
  const acct = seedAccount();
  const msg = seedMessage(acct, { fromAddress: 'other@x.com' });
  P.enqueueMessage(msg, new Date());

  const res = await P.drainPipeline({ selfHeal: false });
  assert.equal(res.ok, 1);
  const row = oneRow(msg, 'test-gated');
  assert.equal(row.status, 'ok');
  assert.equal(row.result, null, 'skipped run stores no result');
  assert.equal(row.durationMs, 0);
});

test('a row whose enricher is no longer registered is skipped and left pending', async () => {
  only(okEnricher);
  const acct = seedAccount();
  const msg = seedMessage(acct);
  P.enqueueMessage(msg, new Date());

  only(); // deregister everything before the drain
  const res = await P.drainPipeline({ selfHeal: false });
  assert.equal(res.skipped, 1);
  assert.equal(oneRow(msg, 'test-ok').status, 'pending', 'left for when the enricher returns');
});

// ========================================================================================
// runner — failure, backoff, dead-letter
// ========================================================================================

test('backoffMs grows exponentially and is capped at one hour', () => {
  assert.equal(P.backoffMs(1), 60_000);
  assert.equal(P.backoffMs(2), 120_000);
  assert.equal(P.backoffMs(3), 240_000);
  assert.equal(P.backoffMs(100), 60 * 60_000, 'capped');
});

test('a throwing enricher fails with a backoff gate, then dead-letters at the attempt cap', async () => {
  only(boomEnricher);
  const acct = seedAccount();
  const msg = seedMessage(acct);
  P.enqueueMessage(msg, new Date());

  // Attempt 1 → failed, gated into the future.
  const t0 = new Date('2026-01-01T00:00:00Z');
  let res = await P.drainPipeline({ selfHeal: false, now: t0 });
  assert.equal(res.failed, 1);
  let row = oneRow(msg, 'test-boom');
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, 1);
  assert.equal(row.error, 'boom');
  assert.ok(row.nextAttemptAt && row.nextAttemptAt.getTime() === t0.getTime() + P.backoffMs(1));

  // Same instant: the backoff gate suppresses re-claim (no infinite loop).
  res = await P.drainPipeline({ selfHeal: false, now: t0 });
  assert.equal(res.claimed, 0, 'still gated');

  // Advance past each gate until the cap parks it dead.
  let now = t0;
  for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
    now = new Date(now.getTime() + P.backoffMs(attempt - 1) + 1);
    res = await P.drainPipeline({ selfHeal: false, now });
    assert.equal(res.claimed, 1, `attempt ${attempt} re-claimed`);
  }
  row = oneRow(msg, 'test-boom');
  assert.equal(row.status, 'dead', 'parked as dead-letter at the cap');
  assert.equal(row.attempts, MAX_ATTEMPTS);
  assert.equal(res.dead, 1);

  // Dead rows are never re-claimed.
  res = await P.drainPipeline({ selfHeal: false, now: new Date(now.getTime() + 10 * DAY_MS) });
  assert.equal(res.claimed, 0);
});

// ========================================================================================
// runner — proposals (the `derived` stage)
// ========================================================================================

test('an enricher proposal is persisted, returned, and re-runs replace UN-ACTED offers', async () => {
  let label = 'first offer';
  const proposer: Enricher = {
    name: 'test-proposer',
    version: 1,
    kind: 'operational',
    run: () => ({ proposals: [{ type: 'calendar_event', title: label, payload: { v: 1 } }] }),
  };
  only(proposer);
  const acct = seedAccount();
  const msg = seedMessage(acct);
  P.enqueueMessage(msg, new Date());

  const res = await P.drainPipeline({ selfHeal: false });
  assert.equal(res.proposals.length, 1);
  assert.deepEqual(res.proposals[0], { messageId: msg, label: 'first offer' });

  let props = db.select().from(schema.proposals).where(eq(schema.proposals.messageId, msg)).all();
  assert.equal(props.length, 1);
  assert.equal(props[0]!.status, 'pending');
  assert.equal(props[0]!.type, 'calendar_event');
  assert.ok(props[0]!.expiresAt, 'a default horizon-bounded expiry was set');

  // Re-run with a fresh label: the prior PENDING proposal is replaced, not duplicated.
  label = 'second offer';
  P.reindex({ kind: 'message', messageId: msg });
  await P.drainPipeline({ selfHeal: false });
  props = db.select().from(schema.proposals).where(eq(schema.proposals.messageId, msg)).all();
  assert.equal(props.length, 1, 'replaced, not stacked');
  assert.equal(props[0]!.title, 'second offer');
});

test('re-running an enricher never clobbers a proposal the user already approved', async () => {
  const proposer: Enricher = {
    name: 'test-proposer2',
    version: 1,
    kind: 'operational',
    run: () => ({ proposals: [{ type: 'package_track', title: 'track it' }] }),
  };
  only(proposer);
  const acct = seedAccount();
  const msg = seedMessage(acct);

  // Pre-existing APPROVED proposal from this enricher.
  db.insert(schema.proposals)
    .values({
      messageId: msg,
      enricher: 'test-proposer2',
      type: 'package_track',
      title: 'approved one',
      status: 'approved',
    })
    .run();

  P.enqueueMessage(msg, new Date());
  await P.drainPipeline({ selfHeal: false });

  const props = db.select().from(schema.proposals).where(eq(schema.proposals.messageId, msg)).all();
  const statuses = props.map((p) => p.status).sort();
  assert.deepEqual(statuses, ['approved', 'pending'], 'approved survived, new pending added');
});

// ========================================================================================
// runner — self-heal, queueDepth, reindex
// ========================================================================================

test('drainPipeline self-heals: an un-enqueued orphan is backfilled and then processed', async () => {
  only(okEnricher);
  const acct = seedAccount();
  const orphan = seedMessage(acct); // never enqueued

  const res = await P.drainPipeline({ selfHeal: true });
  assert.ok(res.ok >= 1);
  assert.equal(oneRow(orphan, 'test-ok').status, 'ok');
});

test('queueDepth counts pending / failed / due / dead', async () => {
  only(okEnricher, boomEnricher);
  const acct = seedAccount();
  const msg = seedMessage(acct);
  P.enqueueMessage(msg, new Date());

  // Before draining: two due pending rows.
  const t0 = new Date('2026-02-01T00:00:00Z');
  let depth = P.queueDepth(t0);
  assert.equal(depth.pending, 2);
  assert.equal(depth.due, 2);

  // After one drain: test-ok → ok, test-boom → failed (gated, so not "due" at t0).
  await P.drainPipeline({ selfHeal: false, now: t0 });
  depth = P.queueDepth(t0);
  assert.equal(depth.pending, 0);
  assert.equal(depth.failed, 1);
  assert.equal(depth.due, 0, 'the failed row is still inside its backoff window');
  assert.equal(depth.dead, 0);
});

test('reindex by message resets that message rows to pending for a clean re-run', async () => {
  only(okEnricher);
  const acct = seedAccount();
  const msg = seedMessage(acct);
  P.enqueueMessage(msg, new Date());
  await P.drainPipeline({ selfHeal: false });
  assert.equal(oneRow(msg, 'test-ok').status, 'ok');

  const changed = P.reindex({ kind: 'message', messageId: msg });
  assert.equal(changed, 1);
  const row = oneRow(msg, 'test-ok');
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 0);
  assert.equal(row.error, null);
});

test('reindex by enricher resets every row of that enricher (version-bump path)', async () => {
  only(okEnricher);
  const acct = seedAccount();
  const a = seedMessage(acct);
  const b = seedMessage(acct);
  P.enqueueMessage(a, new Date());
  P.enqueueMessage(b, new Date());
  await P.drainPipeline({ selfHeal: false });

  const changed = P.reindex({ kind: 'enricher', enricher: 'test-ok' });
  assert.equal(changed, 2);
  assert.equal(oneRow(a, 'test-ok').status, 'pending');
  assert.equal(oneRow(b, 'test-ok').status, 'pending');
});

test('reindex all resets existing rows and backfills any orphan message', async () => {
  only(okEnricher);
  const acct = seedAccount();
  const enqueued = seedMessage(acct);
  P.enqueueMessage(enqueued, new Date());
  await P.drainPipeline({ selfHeal: false });
  const orphan = seedMessage(acct); // never enqueued

  P.reindex({ kind: 'all' });
  assert.equal(oneRow(enqueued, 'test-ok').status, 'pending', 'existing row reset');
  assert.equal(oneRow(orphan, 'test-ok').status, 'pending', 'orphan backfilled by reindex all');
});

// ========================================================================================
// load — the parsed-stage view
// ========================================================================================

test('drain on a message with malformed address JSON degrades to empty recipients', async () => {
  // loadPipelineMessage tolerates bad JSON (returns []); facts then counts 0 recipients.
  only(P.enricherByName('facts')!);
  const acct = seedAccount();
  const msg = seedMessage(acct, {
    toAddresses: 'not json',
    ccAddresses: null,
    fromAddress: null,
    bodyHtml: null,
  });
  P.enqueueMessage(msg, new Date());

  await P.drainPipeline({ selfHeal: false });
  const row = oneRow(msg, 'facts');
  assert.deepEqual(JSON.parse(row.result!), {
    senderDomain: null,
    hasHtmlBody: false,
    recipientCount: 0,
  });
});
