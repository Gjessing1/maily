/**
 * Cleanup trash queue — the execution path for bulk cleanup. A DB-backed, restart-safe,
 * rate-limited trickle of MOVE-to-Trash operations for bulk cleanup. The execute endpoint
 * tombstones the selected messages locally (instant UI hide) and `enqueueTrash`s them here;
 * a background runner then claims due rows in small batches and issues ONE IMAP MOVE per
 * (account, source folder) batch over a transient connection — gentle enough that the
 * account isn't flagged for thousands of individual commands.
 *
 * Trash-only by design: the runner MOVEs to the account's Trash folder and never EXPUNGEs,
 * so moving to Trash *is* the archive-before-delete staging (recoverable; nothing
 * hard-deleted in one step). Detached (local_only) mail is trashed WITHOUT IMAP — a local
 * relink into the trash folder — since it has no server copy to MOVE. Modelled on the
 * `enrichments`-as-queue pattern — a `pending` row with a `nextAttemptAt` backoff gate;
 * terminal failures park as `dead` and un-tombstone the message (see markFailed).
 */
import { and, count, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import { db, withWriteRetry } from '../db/client.js';
import { cleanupQueue, messages } from '../db/schema.js';
import { folderByRole } from '../db/queries.js';
import { serverPlacement } from '../db/placement.js';
import { moveBatchToFolderOnServer, type MoveItem } from '../imap/move.js';
import { getEngine } from '../imap/registry.js';
import { relinkMessageToFolder } from '../imap/store.js';
import { emitSignal } from '../events.js';
import { createLogger } from '../logger.js';
import type { AccountConfig } from '../config/accounts.js';
import type { CleanupMessageRef } from './slices.js';
import type { CleanupQueueStatusDto } from '@maily/shared';

const log = createLogger('cleanup-queue');

/** Messages MOVEd per tick (one IMAP command per source folder). */
const BATCH = 200;
/** Insert chunk size — keeps a single INSERT well under SQLite's bound-variable cap. */
const ENQUEUE_CHUNK = 500;
/** Retries before a row is parked as `dead`. */
const MAX_ATTEMPTS = 5;
/** Linear backoff step applied per attempt after a failed batch. */
const BACKOFF_MS = 60_000;
/** Trickle interval — the runner drains at most BATCH per tick. */
const TICK_MS = 5_000;

/**
 * Enqueue messages for a trash MOVE. Idempotent: the unique index on `message_id` makes a
 * re-queue of an already-queued (or in-flight) message a no-op. Returns the count newly added.
 */
export function enqueueTrash(rows: CleanupMessageRef[], slice: string): number {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += ENQUEUE_CHUNK) {
    const chunk = rows.slice(i, i + ENQUEUE_CHUNK);
    const res = withWriteRetry('enqueueTrash', () =>
      db
        .insert(cleanupQueue)
        .values(chunk.map((r) => ({ messageId: r.id, accountId: r.accountId, slice })))
        .onConflictDoNothing()
        .run(),
    );
    inserted += res.changes;
  }
  return inserted;
}

interface DueRow {
  id: string;
  messageId: string;
  accountId: string;
  attempts: number;
}

/** Claim a bounded snapshot of due pending rows (backoff gate honoured), oldest first. */
function claimDue(now: Date, limit: number): DueRow[] {
  return db
    .select({
      id: cleanupQueue.id,
      messageId: cleanupQueue.messageId,
      accountId: cleanupQueue.accountId,
      attempts: cleanupQueue.attempts,
    })
    .from(cleanupQueue)
    .where(
      and(
        eq(cleanupQueue.status, 'pending'),
        or(isNull(cleanupQueue.nextAttemptAt), lte(cleanupQueue.nextAttemptAt, now)),
      ),
    )
    .orderBy(cleanupQueue.accountId, cleanupQueue.createdAt)
    .limit(limit)
    .all();
}

/** Mark queue rows as successfully trashed. */
function markDone(queueIds: string[]): void {
  if (queueIds.length === 0) return;
  withWriteRetry('trashQueue.markDone', () =>
    db
      .update(cleanupQueue)
      .set({ status: 'done', error: null, updatedAt: new Date() })
      .where(inArray(cleanupQueue.id, queueIds))
      .run(),
  );
}

/**
 * Record a failed batch: bump attempts and either re-arm with a linear backoff (stays
 * `pending`, re-claimed once the gate passes) or park as `dead` once the retry cap is hit.
 *
 * A dead row takes back its local effect — the same rule as the outbox's mailbox intents. The
 * execute route tombstoned the message, but the provider still has it where it was, and resync
 * never re-sights an old UID, so leaving the tombstone would hide mail the user still has.
 */
function markFailed(rows: DueRow[], message: string, now: Date): void {
  const restored = new Map<string, number>();
  for (const row of rows) {
    const attempts = row.attempts + 1;
    const terminal = attempts >= MAX_ATTEMPTS;
    withWriteRetry('trashQueue.markFailed', () =>
      db.transaction(() => {
        db.update(cleanupQueue)
          .set({
            attempts,
            error: message.slice(0, 500),
            status: terminal ? 'dead' : 'pending',
            nextAttemptAt: terminal ? null : new Date(now.getTime() + BACKOFF_MS * attempts),
            updatedAt: now,
          })
          .where(eq(cleanupQueue.id, row.id))
          .run();
        if (terminal) {
          db.update(messages).set({ deletedAt: null }).where(eq(messages.id, row.messageId)).run();
        }
      }),
    );
    if (!terminal) continue;
    emitSignal({ type: 'mail:restored', accountId: row.accountId, messageId: row.messageId });
    restored.set(row.accountId, (restored.get(row.accountId) ?? 0) + 1);
  }
  for (const [accountId, count] of restored) {
    emitSignal({
      type: 'mail:action-failed',
      accountId,
      action: 'cleanup',
      count,
      error: message.slice(0, 200),
    });
  }
}

interface FolderBatch {
  config: AccountConfig;
  trash: { id: string; path: string };
  rows: DueRow[];
  items: MoveItem[];
}

/**
 * Process one bounded snapshot of due work. Groups the claim by (account, source folder)
 * and MOVEs each group to that account's Trash in a single IMAP command. Returns the number
 * of messages trashed this pass (0 when the queue is empty). Never throws — per-batch
 * failures are recorded as backoff/dead so one bad account can't stall the others.
 */
export async function runTrashQueueOnce(): Promise<number> {
  const now = new Date();
  const due = claimDue(now, BATCH);
  if (due.length === 0) return 0;

  // Bucket by (account, source folder); resolve each message's current UID location and the
  // account's trash folder. Rows with no movable location (unmapped) or no trash folder /
  // engine are handled out-of-band below.
  const batches = new Map<string, FolderBatch>();
  const alreadyDone: string[] = []; // already in trash, or nothing to move
  const noTarget: DueRow[] = []; // missing engine/trash folder — retry with backoff
  let movedLocally = 0;

  for (const row of due) {
    const trash = folderByRole(row.accountId, 'trash');
    const loc = serverPlacement(row.messageId);
    // Detached (local_only) mail has no server copy to MOVE — its "move to Trash" is purely
    // local: relink the row into the account's trash folder (uid null) so it surfaces there,
    // recoverable until a Trash purge. No engine needed, so it works for offline accounts too.
    if (loc.kind === 'local-only') {
      if (!trash) {
        noTarget.push(row);
        continue;
      }
      relinkMessageToFolder(row.messageId, trash.id, null);
      alreadyDone.push(row.id);
      movedLocally++;
      continue;
    }
    const engine = getEngine(row.accountId);
    if (!engine || !trash) {
      noTarget.push(row);
      continue;
    }
    if (loc.kind === 'unplaced' || loc.folderPath === trash.path) {
      // Unmapped (nothing to MOVE) or already in Trash — the local tombstone stands; done.
      alreadyDone.push(row.id);
      continue;
    }
    const key = `${row.accountId}\u0000${loc.folderPath}`;
    let batch = batches.get(key);
    if (!batch) {
      batch = { config: engine.accountConfig, trash, rows: [], items: [] };
      batches.set(key, batch);
    }
    batch.rows.push(row);
    batch.items.push({ messageId: row.messageId, uid: loc.uid });
  }

  markDone(alreadyDone);
  if (noTarget.length > 0) markFailed(noTarget, 'no trash folder / engine for account', now);

  let moved = movedLocally;
  for (const [key, batch] of batches) {
    const sourcePath = key.slice(key.indexOf('\u0000') + 1);
    try {
      const ids = await moveBatchToFolderOnServer(
        batch.config,
        batch.items,
        sourcePath,
        batch.trash,
      );
      markDone(batch.rows.map((r) => r.id));
      moved += ids.length;
    } catch (err) {
      const msg = (err as Error).message;
      log.warn(`trash batch failed (${batch.items.length} from ${sourcePath}): ${msg}`);
      markFailed(batch.rows, msg, now);
    }
  }
  return moved;
}

let busy = false;

/** Drain the queue once, guarding against overlapping runs (interval + post-execute nudge). */
async function drain(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    await runTrashQueueOnce();
  } catch (err) {
    log.warn(`trash queue tick failed: ${(err as Error).message}`);
  } finally {
    busy = false;
  }
}

/** Nudge the runner to drain soon (called right after an execute enqueues work). */
export function nudgeTrashQueue(): void {
  void drain();
}

/** Start the background trickle runner. Unref'd so it never holds the process open. */
export function startTrashQueue(): void {
  const timer = setInterval(() => void drain(), TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

/** Headline queue figures for the dashboard progress readout. */
export function queueStatus(): CleanupQueueStatusDto {
  const tally = (status: 'pending' | 'done' | 'dead'): number =>
    db.select({ n: count() }).from(cleanupQueue).where(eq(cleanupQueue.status, status)).get()?.n ??
    0;
  return { pending: tally('pending'), failed: tally('dead'), done: tally('done') };
}
