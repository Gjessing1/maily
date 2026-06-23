/**
 * Outbox runner — the server-owned, restart-safe execution path for deferred actions
 * (migration 0020). Three kinds share one queue:
 *   - `send`    — undo-send (queued with a short window) and scheduled "send later".
 *   - `delete`  — the MOVE-to-Trash behind a delete, deferred so it's undoable.
 *   - `archive` — the MOVE-to-Archive behind an archive, deferred so it's undoable.
 *
 * Why server-side: the old undo window lived in the PWA, so a backgrounded/closed app could
 * drop the commit. Here the backend owns the timer (`dueAt`) and commits regardless of the
 * client. Modelled on cleanup/trashQueue.ts, with two correctness additions for a user-facing
 * UNDO: a `dueAt` gate (only claim once the window elapses) and an atomic `pending`→`sending`
 * flip so a concurrent cancel and the runner can never both win.
 */
import { and, asc, eq, lte, or, isNull, count } from 'drizzle-orm';
import type { SendMessageRequest, OutboxEntry, OutboxKind } from '@maily/shared';
import { db, withWriteRetry } from '../db/client.js';
import { outbox } from '../db/schema.js';
import { folderByRole, uidLocationForMessage, uidLocationInFolder } from '../db/queries.js';
import { restoreMessageDeleted } from '../imap/store.js';
import { moveToFolderOnServer } from '../imap/move.js';
import { getEngine } from '../imap/registry.js';
import { sendMessage } from '../mail/send.js';
import { emitSignal } from '../events.js';
import { createLogger } from '../logger.js';

const log = createLogger('outbox');

/** Rows executed per tick — interactive volume is low, so a small bound is plenty. */
const BATCH = 50;
/** Retries before a row is parked as `dead`. */
const MAX_ATTEMPTS = 5;
/** Linear backoff step applied per attempt after a failure. */
const BACKOFF_MS = 30_000;
/** Poll interval — the `dueAt` gate does the real timing; the tick just needs to be frequent. */
const TICK_MS = 2_000;

interface NewAction {
  accountId: string;
  kind: OutboxKind;
  messageId?: string | null;
  payload?: SendMessageRequest | null;
  /** Epoch ms the action may fire. */
  dueAt: number;
}

/** Insert one deferred action; returns its outbox id. */
function enqueue(action: NewAction): string {
  const row = withWriteRetry('outbox.enqueue', () =>
    db
      .insert(outbox)
      .values({
        accountId: action.accountId,
        kind: action.kind,
        messageId: action.messageId ?? null,
        payload: action.payload ? JSON.stringify(action.payload) : null,
        dueAt: new Date(action.dueAt),
      })
      .returning({ id: outbox.id })
      .get(),
  );
  return row.id;
}

/** Queue a send (undo-send window or scheduled). `dueAt` is when it actually fires. */
export function enqueueSend(accountId: string, req: SendMessageRequest, dueAt: number): string {
  return enqueue({ accountId, kind: 'send', payload: req, dueAt });
}

/** Queue a deferred delete (MOVE-to-Trash) for a message, undoable until `dueAt`. */
export function enqueueDelete(accountId: string, messageId: string, dueAt: number): string {
  return enqueue({ accountId, kind: 'delete', messageId, dueAt });
}

/** Queue a deferred archive (MOVE-to-Archive) for a message, undoable until `dueAt`. */
export function enqueueArchive(accountId: string, messageId: string, dueAt: number): string {
  return enqueue({ accountId, kind: 'archive', messageId, dueAt });
}

export type CancelOutcome = 'canceled' | 'too-late' | 'not-found';

/**
 * Cancel (undo) a pending action. Wins the race against the runner via an atomic
 * `pending`→`canceled` flip: if the runner already claimed it (now `sending`/`done`), the
 * update changes 0 rows and we report `too-late`. On a successful cancel of a delete/archive
 * we reverse the optimistic local hide and emit `mail:restored` so every client un-hides it.
 */
export function cancelOutbox(id: string): CancelOutcome {
  const row = db
    .select({ kind: outbox.kind, accountId: outbox.accountId, messageId: outbox.messageId })
    .from(outbox)
    .where(eq(outbox.id, id))
    .get();
  if (!row) return 'not-found';

  const res = withWriteRetry('outbox.cancel', () =>
    db
      .update(outbox)
      .set({ status: 'canceled', updatedAt: new Date() })
      .where(and(eq(outbox.id, id), eq(outbox.status, 'pending')))
      .run(),
  );
  if (res.changes === 0) return 'too-late';

  if (row.messageId && (row.kind === 'delete' || row.kind === 'archive')) {
    // delete tombstoned locally at enqueue; archive made no local change (the signal hid it).
    if (row.kind === 'delete') restoreMessageDeleted(row.messageId);
    emitSignal({ type: 'mail:restored', accountId: row.accountId, messageId: row.messageId });
  }
  return 'canceled';
}

/** Pending/queued sends (for the Scheduled/Outbox view), soonest-due first. */
export function listPendingSends(): OutboxEntry[] {
  const rows = db
    .select({
      id: outbox.id,
      accountId: outbox.accountId,
      kind: outbox.kind,
      dueAt: outbox.dueAt,
      status: outbox.status,
      payload: outbox.payload,
    })
    .from(outbox)
    .where(and(eq(outbox.kind, 'send'), eq(outbox.status, 'pending')))
    .orderBy(asc(outbox.dueAt))
    .all();
  return rows.map((r) => {
    let subject: string | null = null;
    let to: string[] = [];
    if (r.payload) {
      try {
        const p = JSON.parse(r.payload) as SendMessageRequest;
        subject = p.subject ?? null;
        to = p.to ?? [];
      } catch {
        /* leave defaults */
      }
    }
    return {
      id: r.id,
      accountId: r.accountId,
      kind: r.kind,
      dueAt: r.dueAt.getTime(),
      status: r.status,
      subject,
      to,
    };
  });
}

interface DueRow {
  id: string;
  accountId: string;
  kind: OutboxKind;
  messageId: string | null;
  payload: string | null;
  attempts: number;
}

/** Claim a bounded snapshot of due pending rows (dueAt + backoff gates honoured), oldest first. */
function claimDue(now: Date, limit: number): DueRow[] {
  return db
    .select({
      id: outbox.id,
      accountId: outbox.accountId,
      kind: outbox.kind,
      messageId: outbox.messageId,
      payload: outbox.payload,
      attempts: outbox.attempts,
    })
    .from(outbox)
    .where(
      and(
        eq(outbox.status, 'pending'),
        lte(outbox.dueAt, now),
        or(isNull(outbox.nextAttemptAt), lte(outbox.nextAttemptAt, now)),
      ),
    )
    .orderBy(asc(outbox.dueAt))
    .limit(limit)
    .all();
}

/**
 * Atomically take ownership of a due row: `pending`→`sending`. Returns true only for the caller
 * that actually flipped it, so a concurrent cancel (`pending`→`canceled`) can't be overrun.
 */
function claim(id: string): boolean {
  const res = withWriteRetry('outbox.claim', () =>
    db
      .update(outbox)
      .set({ status: 'sending', updatedAt: new Date() })
      .where(and(eq(outbox.id, id), eq(outbox.status, 'pending')))
      .run(),
  );
  return res.changes === 1;
}

function markDone(id: string): void {
  withWriteRetry('outbox.markDone', () =>
    db
      .update(outbox)
      .set({ status: 'done', error: null, updatedAt: new Date() })
      .where(eq(outbox.id, id))
      .run(),
  );
}

/**
 * Record a failed attempt: bump `attempts` and either re-arm as `pending` with linear backoff
 * (status returns to pending so the next due scan re-claims it) or park as `dead` at the cap.
 * A terminal send emits `mail:send-failed` so the user learns it never went out.
 */
function markFailed(row: DueRow, message: string, now: Date): void {
  const attempts = row.attempts + 1;
  const terminal = attempts >= MAX_ATTEMPTS;
  withWriteRetry('outbox.markFailed', () =>
    db
      .update(outbox)
      .set({
        attempts,
        error: message.slice(0, 500),
        status: terminal ? 'dead' : 'pending',
        nextAttemptAt: terminal ? null : new Date(now.getTime() + BACKOFF_MS * attempts),
        updatedAt: now,
      })
      .where(eq(outbox.id, row.id))
      .run(),
  );
  if (terminal && row.kind === 'send') {
    emitSignal({
      type: 'mail:send-failed',
      accountId: row.accountId,
      outboxId: row.id,
      error: message.slice(0, 200),
    });
  }
}

/** Execute one claimed row. Throws on a retryable failure; returns normally when terminal/done. */
async function execute(row: DueRow): Promise<void> {
  const engine = getEngine(row.accountId);
  if (!engine) throw new Error(`no engine for account ${row.accountId} (not ready yet)`);

  if (row.kind === 'send') {
    if (!row.payload) {
      markDone(row.id); // malformed/empty — nothing to send
      return;
    }
    const req = JSON.parse(row.payload) as SendMessageRequest;
    const result = await sendMessage(engine.accountConfig, req);
    markDone(row.id);
    emitSignal({
      type: 'mail:sent',
      accountId: row.accountId,
      outboxId: row.id,
      messageId: result.messageId,
    });
    return;
  }

  if (!row.messageId) {
    markDone(row.id);
    return;
  }

  if (row.kind === 'delete') {
    const trash = folderByRole(row.accountId, 'trash');
    const loc = uidLocationForMessage(row.messageId);
    if (!trash || !loc || loc.folderPath === trash.path) {
      // No trash folder, or nothing to move / already in Trash — the local tombstone stands.
      markDone(row.id);
      return;
    }
    await moveToFolderOnServer(engine.accountConfig, row.messageId, loc, trash);
    markDone(row.id);
    return;
  }

  // archive
  const archive = folderByRole(row.accountId, 'archive');
  const inbox = folderByRole(row.accountId, 'inbox');
  const loc = inbox ? uidLocationInFolder(row.messageId, inbox.id) : undefined;
  if (!archive || !loc || loc.folderPath === archive.path) {
    // No archive folder, or not in the inbox (already archived/elsewhere) — nothing to do.
    markDone(row.id);
    return;
  }
  await moveToFolderOnServer(engine.accountConfig, row.messageId, loc, archive);
  markDone(row.id);
}

/**
 * Process one bounded snapshot of due work. Returns the number of rows executed this pass.
 * Never throws — per-row failures are recorded as backoff/dead so one bad action can't stall
 * the rest. Each row is atomically claimed first, so a row canceled between claimDue and claim
 * is simply skipped.
 */
export async function runOutboxOnce(): Promise<number> {
  const now = new Date();
  const due = claimDue(now, BATCH);
  if (due.length === 0) return 0;

  let executed = 0;
  for (const row of due) {
    if (!claim(row.id)) continue; // canceled or taken by a racing pass
    try {
      await execute(row);
      executed += 1;
    } catch (err) {
      const msg = (err as Error).message;
      log.warn(`${row.kind} ${row.id} failed: ${msg}`);
      markFailed(row, msg, now);
    }
  }
  return executed;
}

let busy = false;

/** Drain the queue once, guarding against overlapping runs (interval + post-enqueue nudge). */
async function drain(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    await runOutboxOnce();
  } catch (err) {
    log.warn(`outbox tick failed: ${(err as Error).message}`);
  } finally {
    busy = false;
  }
}

/** Nudge the runner to drain soon (called after enqueue/cancel for snappy commits). */
export function nudgeOutbox(): void {
  void drain();
}

/**
 * Re-arm any rows stuck in `sending` from a previous run (process crashed mid-action) back to
 * `pending`. At-least-once: a send that crashed after SMTP but before markDone could re-send on
 * the next pass — a rare, accepted edge for not losing the action outright.
 */
export function resetInflight(): void {
  withWriteRetry('outbox.resetInflight', () =>
    db.update(outbox).set({ status: 'pending' }).where(eq(outbox.status, 'sending')).run(),
  );
}

/** Start the background runner. Unref'd so it never holds the process open. */
export function startOutbox(): void {
  resetInflight();
  const timer = setInterval(() => void drain(), TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

/**
 * Upload ids still referenced by a queued/in-flight send. The staged-uploads sweep must keep
 * these so a scheduled "send later" doesn't lose its attachments before it fires (the sweep
 * otherwise drops files older than 24h, which a far-future schedule would trip).
 */
export function pendingSendUploadIds(): Set<string> {
  const ids = new Set<string>();
  const rows = db
    .select({ payload: outbox.payload })
    .from(outbox)
    .where(
      and(eq(outbox.kind, 'send'), or(eq(outbox.status, 'pending'), eq(outbox.status, 'sending'))),
    )
    .all();
  for (const r of rows) {
    if (!r.payload) continue;
    try {
      const p = JSON.parse(r.payload) as SendMessageRequest;
      for (const u of p.uploads ?? []) ids.add(u.uploadId);
    } catch {
      /* skip malformed */
    }
  }
  return ids;
}

/** Count of pending send rows — small helper for tests/diagnostics. */
export function pendingSendCount(): number {
  return (
    db
      .select({ n: count() })
      .from(outbox)
      .where(and(eq(outbox.kind, 'send'), eq(outbox.status, 'pending')))
      .get()?.n ?? 0
  );
}
