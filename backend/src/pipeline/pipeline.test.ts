/**
 * Enrichment-pipeline framework coverage (ROADMAP Phase 4; ARCHITECTURE §14/§15).
 *
 * Pins the framework's load-bearing behaviour around the (deliberately trivial)
 * reference enricher and purpose-built test enrichers:
 *   - age-tiering + the operational-suppression rule (a backfill must never fire
 *     operational side effects on old mail),
 *   - the SQLite-backed pull/claim queue: enqueue (idempotent), self-heal backfill,
 *     claim → run → persist, retry-with-backoff → dead-letter,
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
  // FK cascade from messages clears enrichments; clear all then accounts.
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

// ========================================================================================
// travel — JSON-LD reservation extraction → calendar offers
// ========================================================================================

/** Wrap JSON-LD in a `<script>` block the way travel mail embeds it. */
function ldHtml(json: unknown): string {
  return `<html><body><p>Your booking</p><script type="application/ld+json">${JSON.stringify(
    json,
  )}</script></body></html>`;
}

/** Build a minimal PipelineMessage carrying the given HTML body (direct-run unit tests). */
function pmsg(bodyHtml: string | null): PipelineMessage {
  return {
    id: randomUUID(),
    accountId: randomUUID(),
    threadId: null,
    subject: 'Booking',
    fromName: null,
    fromAddress: 'noreply@airline.com',
    to: [],
    cc: [],
    snippet: null,
    bodyText: null,
    bodyHtml,
    bodyCalendar: null,
    inReplyTo: null,
    references: null,
    sentAt: null,
    receivedAt: new Date(),
    sourcePath: null,
  };
}

const FLIGHT_LD = {
  '@context': 'http://schema.org',
  '@type': 'FlightReservation',
  reservationNumber: 'ABC123',
  reservationFor: {
    '@type': 'Flight',
    flightNumber: '110',
    airline: { '@type': 'Airline', name: 'United', iataCode: 'UA' },
    departureAirport: { '@type': 'Airport', name: 'San Francisco', iataCode: 'SFO' },
    departureTime: '2099-03-04T20:15:00-08:00',
    arrivalAirport: { '@type': 'Airport', name: 'JFK', iataCode: 'JFK' },
    arrivalTime: '2099-03-05T06:30:00-05:00',
  },
};

test('travel: the enricher self-registers as a passive search extractor', () => {
  const travel = P.enricherByName('travel');
  assert.ok(travel, 'travel enricher is registered by default');
  assert.equal(travel.kind, 'search');
});

test('travel: applies() only fires for HTML bodies carrying JSON-LD', () => {
  const travel = P.enricherByName('travel')!;
  assert.equal(travel.applies!(pmsg(ldHtml(FLIGHT_LD))), true);
  assert.equal(travel.applies!(pmsg('<p>plain</p>')), false);
  assert.equal(travel.applies!(pmsg(null)), false);
});

test('travel: extracts a FlightReservation into a normalised result', async () => {
  const travel = P.enricherByName('travel')!;
  const out = await travel.run({ message: pmsg(ldHtml(FLIGHT_LD)), tier: 0 });
  const result = out.result as { reservations: Array<Record<string, unknown>> };
  assert.equal(result.reservations.length, 1);
  assert.deepEqual(result.reservations[0], {
    type: 'flight',
    reservationNumber: 'ABC123',
    title: 'UA110 SFO→JFK',
    startsAt: '2099-03-04T20:15:00-08:00',
    endsAt: '2099-03-05T06:30:00-05:00',
    location: 'SFO → JFK',
  });
});

test('travel: extracts a LodgingReservation (dates live on the reservation)', async () => {
  const travel = P.enricherByName('travel')!;
  const ld = {
    '@type': 'LodgingReservation',
    reservationNumber: 'H-9',
    checkinTime: '2099-04-11T16:00:00-05:00',
    checkoutTime: '2099-04-13T11:00:00-05:00',
    reservationFor: {
      '@type': 'LodgingBusiness',
      name: 'Grand Hotel',
      address: { '@type': 'PostalAddress', streetAddress: '1 Main St', addressLocality: 'Austin' },
    },
  };
  const out = await travel.run({ message: pmsg(ldHtml(ld)), tier: 0 });
  const r = (out.result as { reservations: Array<Record<string, unknown>> }).reservations[0]!;
  assert.equal(r.type, 'lodging');
  assert.equal(r.title, 'Grand Hotel');
  assert.equal(r.startsAt, '2099-04-11T16:00:00-05:00');
  assert.equal(r.endsAt, '2099-04-13T11:00:00-05:00');
  assert.equal(r.location, '1 Main St, Austin');
});

test('travel: extracts an EventReservation from a `@graph` wrapper', async () => {
  const travel = P.enricherByName('travel')!;
  const ld = {
    '@context': 'http://schema.org',
    '@graph': [
      { '@type': 'WebSite', name: 'Tickets' },
      {
        '@type': 'EventReservation',
        reservationNumber: 'EVT-7',
        reservationFor: {
          '@type': 'Event',
          name: 'Foo Fighters',
          startDate: '2099-03-09T19:30:00-08:00',
          location: { '@type': 'Place', name: 'The Fillmore' },
        },
      },
    ],
  };
  const out = await travel.run({ message: pmsg(ldHtml(ld)), tier: 0 });
  const r = (out.result as { reservations: Array<Record<string, unknown>> }).reservations[0]!;
  assert.equal(r.type, 'event');
  assert.equal(r.title, 'Foo Fighters');
  assert.equal(r.startsAt, '2099-03-09T19:30:00-08:00');
  assert.equal(r.location, 'The Fillmore');
});

test('travel: tolerates a malformed JSON-LD block and parses the valid sibling', async () => {
  const travel = P.enricherByName('travel')!;
  const html =
    `<script type="application/ld+json">{ not valid json }</script>` +
    `<script type="application/ld+json">${JSON.stringify([FLIGHT_LD])}</script>`;
  const out = await travel.run({ message: pmsg(html), tier: 0 });
  assert.equal((out.result as { reservations: unknown[] }).reservations.length, 1);
});

test('travel: a non-reservation JSON-LD body yields no reservations', async () => {
  const travel = P.enricherByName('travel')!;
  const out = await travel.run({
    message: pmsg(ldHtml({ '@type': 'Organization', name: 'ACME' })),
    tier: 0,
  });
  assert.deepEqual(out.result, { reservations: [] });
});

test('travel: end-to-end drain persists the reservation result', async () => {
  only(P.enricherByName('travel')!);
  const acct = seedAccount();
  const msg = seedMessage(acct, { receivedAt: new Date(), bodyHtml: ldHtml(FLIGHT_LD) });
  P.enqueueMessage(msg, new Date());

  const res = await P.drainPipeline({ selfHeal: false });
  assert.equal(res.ok, 1);

  const row = oneRow(msg, 'travel');
  assert.equal(row.status, 'ok');
  const result = JSON.parse(row.result!) as { reservations: Array<{ title: string }> };
  assert.equal(result.reservations.length, 1);
  assert.equal(result.reservations[0]!.title, 'UA110 SFO→JFK');
});

test('travel: search-kind runs on old mail too (no tier suppression)', () => {
  // travel is a passive extractor now — old mail stays fully indexed (ARCHITECTURE §14:
  // search/analytical run on all tiers; only operational side effects are Tier-0 gated).
  only(P.enricherByName('travel')!);
  const names = P.enrichersForTier(1).map((e) => e.name);
  assert.deepEqual(names, ['travel'], 'travel still enqueues for older mail');
});

// ========================================================================================
// cost scheduling (Phase 5) — cheap vs llm: bounded batches + per-enricher coverage
// ========================================================================================

/** A `cheap` deterministic enricher (default cost). */
const cheapEnricher: Enricher = {
  name: 'test-cheap',
  version: 1,
  kind: 'search',
  run: () => ({ result: { c: 1 } }),
};

/** An `analytical`/`llm`-cost enricher standing in for an Ollama enricher. */
const llmEnricherA: Enricher = {
  name: 'test-llm',
  version: 1,
  kind: 'analytical',
  cost: 'llm',
  run: () => ({ result: { s: 1 } }),
};

test('enqueueMessage stamps the enricher cost onto the ledger row', () => {
  only(cheapEnricher, llmEnricherA);
  const acct = seedAccount();
  const m = seedMessage(acct);
  P.enqueueMessage(m, new Date());

  assert.equal(oneRow(m, 'test-cheap').cost, 'cheap', 'default cost is cheap');
  assert.equal(oneRow(m, 'test-llm').cost, 'llm');
});

test('drainPipeline costs:[cheap] runs only cheap rows; llm rows are left pending', async () => {
  only(cheapEnricher, llmEnricherA);
  const acct = seedAccount();
  const m = seedMessage(acct);
  P.enqueueMessage(m, new Date());

  const res = await P.drainPipeline({ selfHeal: false, costs: ['cheap'] });
  assert.equal(res.claimed, 1);
  assert.equal(res.ok, 1);
  assert.equal(oneRow(m, 'test-cheap').status, 'ok');
  assert.equal(oneRow(m, 'test-llm').status, 'pending', 'the llm row is untouched');
});

test('drainPipeline costs:[llm] with max bounds the batch (the N150 trickle)', async () => {
  only(llmEnricherA);
  const acct = seedAccount();
  for (let i = 0; i < 5; i++) P.enqueueMessage(seedMessage(acct), new Date());

  // Only 2 of the 5 due llm rows run this drain; the rest wait for the next nudge.
  let res = await P.drainPipeline({ selfHeal: false, costs: ['llm'], max: 2 });
  assert.equal(res.claimed, 2);
  assert.equal(res.ok, 2);

  res = await P.drainPipeline({ selfHeal: false, costs: ['llm'], max: 2 });
  assert.equal(res.ok, 2);
  res = await P.drainPipeline({ selfHeal: false, costs: ['llm'], max: 2 });
  assert.equal(res.ok, 1, 'the last row drains on the third nudge');
});

test('a deep cheap-cost claim window cannot starve a freshly added llm enricher', async () => {
  // cheap and llm rows are claimed by independent cost-scoped scans, so the cheap drain
  // never sits in front of the llm work (the starvation the cost column exists to prevent).
  only(cheapEnricher, llmEnricherA);
  const acct = seedAccount();
  const m = seedMessage(acct);
  P.enqueueMessage(m, new Date());

  await P.drainPipeline({ selfHeal: false, costs: ['cheap'] }); // cheap done
  const res = await P.drainPipeline({ selfHeal: false, costs: ['llm'] });
  assert.equal(res.ok, 1);
  assert.equal(oneRow(m, 'test-llm').status, 'ok');
});

test('backfillEnricherCoverage enqueues a newly added enricher across existing mail', () => {
  // A message already carrying one enricher's row (the Phase-4 case) is invisible to
  // backfillPending (zero-row only); coverage is how a new Phase-5 enricher reaches it.
  only(cheapEnricher);
  const acct = seedAccount();
  const m = seedMessage(acct);
  P.enqueueMessage(m, new Date());
  assert.equal(rowsFor(m).length, 1);

  only(cheapEnricher, llmEnricherA); // llm enricher added after the fact
  const inserted = P.backfillEnricherCoverage(500);
  assert.equal(inserted, 1);
  const row = oneRow(m, 'test-llm');
  assert.equal(row.status, 'pending');
  assert.equal(row.cost, 'llm');
});

test('backfillEnricherCoverage horizon-gates operational enrichers off old mail', () => {
  only(opEnricher); // operational
  const acct = seedAccount();
  const now = new Date('2026-06-01T00:00:00Z');
  const recent = seedMessage(acct, { receivedAt: now });
  const old = seedMessage(acct, {
    receivedAt: new Date(now.getTime() - (HORIZON_DAYS + 5) * DAY_MS),
  });

  const inserted = P.backfillEnricherCoverage(500, now);
  assert.equal(inserted, 1, 'only the recent message gets an operational row');
  assert.equal(rowsFor(recent).length, 1);
  assert.equal(rowsFor(old).length, 0, 'no stale operational work manufactured on old mail');
});

test('enrichmentProgress folds ledger counts into overall + llm slices', async () => {
  only(cheapEnricher, llmEnricherA);
  const acct = seedAccount();
  for (let i = 0; i < 3; i++) P.enqueueMessage(seedMessage(acct), new Date());

  // 3 messages × {cheap, llm} = 6 pending rows, 3 of them llm.
  let p = P.enrichmentProgress();
  assert.deepEqual(p.overall, { total: 6, done: 0, pending: 6, failed: 0, dead: 0 });
  assert.deepEqual(p.llm, { total: 3, done: 0, pending: 3, failed: 0, dead: 0 });

  // Cheap drain marks the 3 cheap rows done; the llm slice is untouched.
  await P.drainPipeline({ selfHeal: false, costs: ['cheap'] });
  p = P.enrichmentProgress();
  assert.deepEqual(p.overall, { total: 6, done: 3, pending: 3, failed: 0, dead: 0 });
  assert.deepEqual(p.llm, { total: 3, done: 0, pending: 3, failed: 0, dead: 0 });

  // LLM drain finishes the rest.
  await P.drainPipeline({ selfHeal: false, costs: ['llm'] });
  p = P.enrichmentProgress();
  assert.deepEqual(p.overall, { total: 6, done: 6, pending: 0, failed: 0, dead: 0 });
  assert.deepEqual(p.llm, { total: 3, done: 3, pending: 0, failed: 0, dead: 0 });
});

test('drainPipeline onRowStart reports each claimed row before it runs', async () => {
  only(llmEnricherA);
  const acct = seedAccount();
  const m = seedMessage(acct); // subject defaults to 'Subject'
  P.enqueueMessage(m, new Date());

  const seen: PipelineNS.RowStartInfo[] = [];
  await P.drainPipeline({ selfHeal: false, costs: ['llm'], onRowStart: (i) => seen.push(i) });

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], {
    enricher: 'test-llm',
    messageId: m,
    cost: 'llm',
    subject: 'Subject',
  });
});
