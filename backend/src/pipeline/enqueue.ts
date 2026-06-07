/**
 * Enqueue — turn a message into pending pipeline work.
 *
 * The pipeline is a PULL/claim queue backed by SQLite, not an in-memory queue: a
 * unit of work IS a `pending` row in the `enrichments` ledger. That makes it
 * restart-safe and reindex-native (a rebuildable projection over messages, §15).
 * The ingest hook just calls `enqueueMessage`; the worker nudge that follows is an
 * optimisation, not a correctness requirement — `backfillPending` self-heals any
 * message that was inserted without ever being enqueued (e.g. by the source sweep,
 * or synced before the pipeline existed).
 *
 * A pending row is inserted for every enricher eligible at the message's tier. The
 * enricher's own `applies()` gate is evaluated later, at RUN time, so enqueue stays
 * cheap (needs only the received date, never the full body).
 */
import { and, eq, isNull, notExists } from 'drizzle-orm';
import { db, withWriteRetry } from '../db/client.js';
import { enrichments, messages } from '../db/schema.js';
import { enrichersForTier } from './registry.js';
import { tierForMessage } from './tiers.js';

/** Insert pending rows for a message's tier-eligible enrichers. Returns rows inserted. */
export function enqueueMessage(
  messageId: string,
  receivedAt: Date | null,
  now: Date = new Date(),
): number {
  const tier = tierForMessage(receivedAt, now);
  const eligible = enrichersForTier(tier);
  if (eligible.length === 0) return 0;
  return withWriteRetry('pipeline.enqueueMessage', () => {
    let inserted = 0;
    for (const e of eligible) {
      const r = db
        .insert(enrichments)
        .values({
          messageId,
          enricher: e.name,
          enricherVersion: e.version,
          kind: e.kind,
          status: 'pending',
          attempts: 0,
          nextAttemptAt: null,
        })
        // Idempotent: a row for this (message, enricher) already exists → leave it.
        .onConflictDoNothing({ target: [enrichments.messageId, enrichments.enricher] })
        .run();
      inserted += r.changes;
    }
    return inserted;
  });
}

/**
 * Self-heal: enqueue up to `limit` non-deleted messages that have NO enrichment rows
 * at all (synced before the pipeline existed, or inserted by the source sweep without
 * a nudge). Newest first. Coverage gaps from a *newly added* enricher or a version
 * bump are handled by `reindex`, not here.
 */
export function backfillPending(limit: number, now: Date = new Date()): number {
  const orphans = db
    .select({ id: messages.id, receivedAt: messages.receivedAt })
    .from(messages)
    .where(
      and(
        isNull(messages.deletedAt),
        notExists(
          db
            .select({ one: enrichments.id })
            .from(enrichments)
            .where(eq(enrichments.messageId, messages.id)),
        ),
      ),
    )
    .orderBy(messages.receivedAt)
    .limit(limit)
    .all();

  let enqueued = 0;
  for (const m of orphans) enqueued += enqueueMessage(m.id, m.receivedAt, now);
  return enqueued;
}
