/**
 * Pipeline runner — claims due `pending` enrichment rows, runs the enricher, and
 * persists results / proposals, with retry + backoff + dead-lettering. Runs inside
 * the shared sync worker (`better-sqlite3` is synchronous; keep it off the event
 * loop). The queue lives in SQLite, so this is restart-safe and idempotent: a drain
 * processes a bounded snapshot of due work and returns; periodic nudges continue the
 * backlog. Reindex/version bumps just reset rows to `pending` (the §15 rebuild path).
 */
import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { db, withWriteRetry } from '../db/client.js';
import { enrichments, proposals } from '../db/schema.js';
import { env } from '../env.js';
import { createLogger } from '../logger.js';
import { enricherByName } from './registry.js';
import { backfillEnricherCoverage, backfillPending } from './enqueue.js';
import { loadPipelineMessage } from './load.js';
import { tierForMessage } from './tiers.js';
import type { Enricher, EnricherResult, EnrichmentCost, PipelineMessage } from './types.js';

const log = createLogger('pipeline');

const DAY_MS = 24 * 60 * 60 * 1000;
const BACKOFF_BASE_MS = 60_000; // 1 min
const BACKOFF_CAP_MS = 60 * 60_000; // 1 h

/** Exponential backoff for retry attempt `n` (1-based), capped. */
export function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
}

/** A proposal surfaced this drain — relayed to the main thread to signal the UI. */
export interface ProposalReady {
  messageId: string;
  label: string;
}

export interface DrainResult {
  claimed: number;
  ok: number;
  failed: number;
  dead: number;
  /** Rows whose enricher is no longer registered (left pending, untouched). */
  skipped: number;
  proposals: ProposalReady[];
}

type EnrichmentRow = typeof enrichments.$inferSelect;

/**
 * Claim up to `limit` rows due for a run: never-attempted (`pending`) or errored-and-
 * retrying (`failed`) rows whose backoff gate has passed. `dead` and `ok` are excluded.
 * `costs` scopes the claim to one or more cost classes (Phase 5): the worker drains
 * `['cheap']` to completion, then a small bounded batch of `['llm']`, so a deep LLM
 * backlog can't sit at the front of the createdAt order and starve cheap mail.
 */
function claimDue(now: Date, limit: number, costs?: EnrichmentCost[]): EnrichmentRow[] {
  return db
    .select()
    .from(enrichments)
    .where(
      and(
        inArray(enrichments.status, ['pending', 'failed']),
        or(isNull(enrichments.nextAttemptAt), lte(enrichments.nextAttemptAt, now)),
        costs ? inArray(enrichments.cost, costs) : undefined,
      ),
    )
    .orderBy(enrichments.createdAt)
    .limit(limit)
    .all();
}

/** Persist a successful run: ok status + result, and replace this enricher's pending proposals. */
function persistSuccess(
  row: EnrichmentRow,
  enricher: Enricher,
  out: EnricherResult,
  durationMs: number,
  now: Date,
): ProposalReady[] {
  const ready: ProposalReady[] = [];
  withWriteRetry('pipeline.persistSuccess', () =>
    db.transaction(() => {
      db.update(enrichments)
        .set({
          status: 'ok',
          enricherVersion: enricher.version,
          result: out.result === undefined ? null : JSON.stringify(out.result),
          error: null,
          durationMs,
          nextAttemptAt: null,
          updatedAt: now,
        })
        .where(eq(enrichments.id, row.id))
        .run();

      // Replace only this enricher's UN-ACTED proposals so re-runs are idempotent;
      // never clobber ones the user already approved/dismissed.
      db.delete(proposals)
        .where(
          and(
            eq(proposals.messageId, row.messageId),
            eq(proposals.enricher, enricher.name),
            eq(proposals.status, 'pending'),
          ),
        )
        .run();

      for (const p of out.proposals ?? []) {
        const expiresAt =
          p.expiresAt === undefined
            ? new Date(now.getTime() + env.pipelineHorizonDays * DAY_MS)
            : p.expiresAt;
        db.insert(proposals)
          .values({
            messageId: row.messageId,
            enricher: enricher.name,
            type: p.type,
            title: p.title ?? null,
            payload: p.payload === undefined ? null : JSON.stringify(p.payload),
            status: 'pending',
            expiresAt,
          })
          .run();
        ready.push({ messageId: row.messageId, label: p.title ?? p.type });
      }
    }),
  );
  return ready;
}

/** Persist a no-op success (enricher's `applies()` gate declined the message). */
function persistSkipped(row: EnrichmentRow, enricher: Enricher, now: Date): void {
  withWriteRetry('pipeline.persistSkipped', () =>
    db
      .update(enrichments)
      .set({
        status: 'ok',
        enricherVersion: enricher.version,
        result: null,
        error: null,
        durationMs: 0,
        nextAttemptAt: null,
        updatedAt: now,
      })
      .where(eq(enrichments.id, row.id))
      .run(),
  );
}

/** Persist a failed run: retry with backoff, or park as dead-letter at the attempt cap. */
function persistFailure(
  row: EnrichmentRow,
  message: string,
  durationMs: number,
  now: Date,
): 'failed' | 'dead' {
  const attempts = row.attempts + 1;
  const terminal = attempts >= env.pipelineMaxAttempts;
  withWriteRetry('pipeline.persistFailure', () =>
    db
      .update(enrichments)
      .set({
        // 'failed' rows are re-claimed once their backoff gate passes; 'dead' rows aren't.
        status: terminal ? 'dead' : 'failed',
        attempts,
        error: message.slice(0, 2000),
        durationMs,
        nextAttemptAt: terminal ? null : new Date(now.getTime() + backoffMs(attempts)),
        updatedAt: now,
      })
      .where(eq(enrichments.id, row.id))
      .run(),
  );
  return terminal ? 'dead' : 'failed';
}

/**
 * Index stage seam (ROADMAP Phase 4 "semantic index build step"). Named, no-op
 * extension point invoked after a row reaches `enriched`. FTS is its first future
 * occupant; embeddings slot in here later with no schema change.
 */
function indexStage(_message: PipelineMessage, _result: EnricherResult): void {
  // intentionally empty for the framework pass
}

/** Run one claimed row to completion; returns the terminal-ish outcome. */
async function processRow(
  row: EnrichmentRow,
  now: Date,
): Promise<{ outcome: 'ok' | 'failed' | 'dead' | 'skipped'; proposals: ProposalReady[] }> {
  const enricher = enricherByName(row.enricher);
  if (!enricher) return { outcome: 'skipped', proposals: [] }; // deregistered → leave pending

  const message = loadPipelineMessage(row.messageId);
  if (!message) {
    persistFailure(row, 'message row not found', 0, now);
    return { outcome: 'failed', proposals: [] };
  }

  if (enricher.applies && !enricher.applies(message)) {
    persistSkipped(row, enricher, now);
    return { outcome: 'ok', proposals: [] };
  }

  const tier = tierForMessage(message.receivedAt, now);
  const started = Date.now();
  try {
    const out = await enricher.run({ message, tier });
    const durationMs = Date.now() - started;
    const ready = persistSuccess(row, enricher, out, durationMs, now);
    indexStage(message, out);
    return { outcome: 'ok', proposals: ready };
  } catch (err) {
    const durationMs = Date.now() - started;
    const outcome = persistFailure(row, (err as Error).message, durationMs, now);
    return { outcome, proposals: [] };
  }
}

export interface DrainOptions {
  /** Override "now" (tests). */
  now?: Date;
  /** Max rows processed in this drain (the backlog continues on the next nudge). */
  max?: number;
  /** When the claim is empty, run a bounded self-heal backfill first. Default true. */
  selfHeal?: boolean;
  /** Self-heal scan size. */
  backfillLimit?: number;
  /**
   * Restrict this drain to one or more cost classes (Phase 5). Omitted = all costs
   * (the default; preserves single-pass behaviour for tests and any non-worker caller).
   * The worker drains `['cheap']` to completion, then one bounded `['llm']` batch.
   */
  costs?: EnrichmentCost[];
}

/**
 * Process one bounded snapshot of due work. Single-pass over a claimed snapshot:
 * failed rows get a future backoff gate (so they're not re-claimed this drain) and
 * skipped rows are left pending — no infinite loop. Rows enqueued mid-drain are
 * picked up by the next nudge.
 */
export async function drainPipeline(opts: DrainOptions = {}): Promise<DrainResult> {
  const now = opts.now ?? new Date();
  const max = opts.max ?? 500;
  const selfHeal = opts.selfHeal ?? true;
  const costs = opts.costs;

  let rows = claimDue(now, max, costs);
  if (rows.length === 0 && selfHeal) {
    // Idle: top up coverage. `backfillPending` reaches messages with NO rows at all;
    // `backfillEnricherCoverage` reaches messages missing a *specific* enricher (how a
    // newly added LLM enricher catches up on the existing mailbox). Re-claim afterwards.
    const limit = opts.backfillLimit ?? 500;
    backfillPending(limit, now);
    backfillEnricherCoverage(limit, now);
    rows = claimDue(now, max, costs);
  }

  const result: DrainResult = {
    claimed: rows.length,
    ok: 0,
    failed: 0,
    dead: 0,
    skipped: 0,
    proposals: [],
  };
  for (const row of rows) {
    const { outcome, proposals: ready } = await processRow(row, now);
    result[outcome] += 1;
    if (ready.length) result.proposals.push(...ready);
  }

  if (result.claimed > 0) {
    log.info(
      `drain: ${result.ok} ok, ${result.failed} retry, ${result.dead} dead, ` +
        `${result.skipped} skipped (${result.proposals.length} proposal(s))`,
    );
  }
  return result;
}

/** Observability counts for the ledger (Settings / logs). */
export function queueDepth(now: Date = new Date()): {
  pending: number;
  failed: number;
  due: number;
  dead: number;
} {
  const countStatus = (status: EnrichmentRow['status']): number =>
    db
      .select({ n: sql<number>`count(*)` })
      .from(enrichments)
      .where(eq(enrichments.status, status))
      .get()?.n ?? 0;

  const due =
    db
      .select({ n: sql<number>`count(*)` })
      .from(enrichments)
      .where(
        and(
          inArray(enrichments.status, ['pending', 'failed']),
          or(isNull(enrichments.nextAttemptAt), lte(enrichments.nextAttemptAt, now)),
        ),
      )
      .get()?.n ?? 0;

  return {
    pending: countStatus('pending'),
    failed: countStatus('failed'),
    due,
    dead: countStatus('dead'),
  };
}

/**
 * Reindex — reset matching rows to `pending` so they re-run idempotently (converges
 * by message UUID + enricher version, §15). Also ensures rows exist for the target
 * messages (so a re-run after adding fields/enrichers fills gaps). Scope:
 *  - `{ kind: 'all' }`        — every row, plus a self-heal backfill for orphan messages.
 *  - `{ kind: 'message' }`    — one message's rows.
 *  - `{ kind: 'enricher' }`   — every row of one enricher (e.g. after a version bump).
 */
export type ReindexScope =
  | { kind: 'all' }
  | { kind: 'message'; messageId: string }
  | { kind: 'enricher'; enricher: string };

export function reindex(scope: ReindexScope, now: Date = new Date()): number {
  const reset = {
    status: 'pending' as const,
    attempts: 0,
    nextAttemptAt: null,
    error: null,
    updatedAt: now,
  };
  return withWriteRetry('pipeline.reindex', () => {
    if (scope.kind === 'message') {
      return db
        .update(enrichments)
        .set(reset)
        .where(eq(enrichments.messageId, scope.messageId))
        .run().changes;
    }
    if (scope.kind === 'enricher') {
      return db.update(enrichments).set(reset).where(eq(enrichments.enricher, scope.enricher)).run()
        .changes;
    }
    // 'all': reset everything; backfill picks up any never-enqueued messages.
    const changed = db.update(enrichments).set(reset).run().changes;
    backfillPending(Number.MAX_SAFE_INTEGER, now);
    return changed;
  });
}
