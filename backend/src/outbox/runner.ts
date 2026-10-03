/**
 * Outbox runner — the server-owned, restart-safe execution path for every action that reaches
 * the provider on the user's behalf (migration 0020). Five kinds share one queue:
 *   - `send`    — undo-send (queued with a short window) and scheduled "send later".
 *   - `delete`  — the MOVE-to-Trash behind a delete, deferred so it's undoable.
 *   - `archive` — the MOVE-to-Archive behind an archive, deferred so it's undoable.
 *   - `move`    — a MOVE between role folders (Report spam / Not spam), deferred likewise.
 *   - `flags`   — a read/star STORE, due immediately; due rows are batched per folder.
 *
 * delete/archive/move/flags are mailbox intents (./intents.ts): the local effect is applied in the
 * enqueue transaction and the inverse runs on cancel and on `dead`, followed by a signal, so a
 * provider that never takes the change can't leave maily showing something it doesn't have.
 *
 * Why server-side: the old undo window lived in the PWA, so a backgrounded/closed app could
 * drop the commit. Here the backend owns the timer (`dueAt`) and commits regardless of the
 * client. Modelled on cleanup/trashQueue.ts, with two correctness additions for a user-facing
 * UNDO: a `dueAt` gate (only claim once the window elapses) and an atomic `pending`→`sending`
 * flip so a concurrent cancel and the runner can never both win.
 */
import { and, asc, eq, lte, or, isNull, count, inArray, lt, sql } from 'drizzle-orm';
import type {
  FolderRole,
  MailboxAction,
  OutboxEntry,
  OutboxKind,
  SendMessageRequest,
} from '@maily/shared';
import { db, withWriteRetry } from '../db/client.js';
import { folders, outbox } from '../db/schema.js';
import { folderByRole } from '../db/queries.js';
import { isMessageLocalOnly, serverPlacement, type ServerPlacement } from '../db/placement.js';
import { relinkMessageToFolder } from '../imap/store.js';
import { moveToFolderOnServer } from '../imap/move.js';
import { storeFlagsOnServer, type FlagStore } from '../imap/flags.js';
import {
  applyDelete,
  applyFlags,
  applyMove,
  currentFlags,
  parsePayload,
  revertDelete,
  revertFlags,
  revertMove,
  type DeletePayload,
  type FlagName,
  type FlagSet,
  type FlagsPayload,
  type MovePayload,
} from './intents.js';
import { getEngine } from '../imap/registry.js';
import { sendMessage } from '../mail/send.js';
import { saveDraft } from '../mail/draft.js';
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

/** How long finished rows (done/canceled/dead) are kept for diagnostics before pruning. */
const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 6 * 60 * 60 * 1000;

interface NewAction {
  accountId: string;
  kind: OutboxKind;
  messageId?: string | null;
  payload?: unknown;
  /** Epoch ms the action may fire. */
  dueAt: number;
}

/** Insert one row; returns its outbox id. Call inside the caller's write transaction. */
function insertRow(action: NewAction): string {
  return db
    .insert(outbox)
    .values({
      accountId: action.accountId,
      kind: action.kind,
      messageId: action.messageId ?? null,
      payload: action.payload == null ? null : JSON.stringify(action.payload),
      dueAt: new Date(action.dueAt),
      // Millisecond precision: flags inverses order rows by insertion (rowid), and reads of
      // this column for diagnostics shouldn't collapse a burst of toggles onto one second.
      createdAt: new Date(),
    })
    .returning({ id: outbox.id })
    .get().id;
}

/**
 * Apply an intent's local effect and record it, atomically: either both the local change and
 * the row that will push it (or take it back) exist, or neither does.
 */
function enqueueIntent<P>(
  accountId: string,
  kind: 'delete' | 'archive' | 'move' | 'flags',
  messageId: string,
  dueAt: number,
  apply: () => P,
): { id: string; payload: P } {
  return withWriteRetry(`outbox.enqueue.${kind}`, () =>
    db.transaction(() => {
      const payload = apply();
      return { id: insertRow({ accountId, kind, messageId, payload, dueAt }), payload };
    }),
  );
}

/** Queue a send (undo-send window or scheduled). `dueAt` is when it actually fires. */
export function enqueueSend(accountId: string, req: SendMessageRequest, dueAt: number): string {
  return withWriteRetry('outbox.enqueue.send', () =>
    insertRow({ accountId, kind: 'send', payload: req, dueAt }),
  );
}

/** Delete: tombstone now (every view hides it), MOVE to Trash at `dueAt` unless undone. */
export function enqueueDelete(accountId: string, messageId: string, dueAt: number): string {
  const { id } = enqueueIntent(accountId, 'delete', messageId, dueAt, () => applyDelete(messageId));
  emitSignal({ type: 'mail:deleted', accountId, messageId });
  return id;
}

/** Archive: leave the inbox now (local relink), MOVE to Archive at `dueAt` unless undone. */
export function enqueueArchive(
  accountId: string,
  messageId: string,
  archiveId: string,
  dueAt: number,
): string {
  const inboxId = folderByRole(accountId, 'inbox')?.id;
  const { id } = enqueueIntent(accountId, 'archive', messageId, dueAt, () =>
    applyMove(messageId, inboxId, archiveId),
  );
  emitSignal({ type: 'mail:archived', accountId, messageId });
  return id;
}

/**
 * Move between role folders (Report spam: → junk; Not spam: junk → inbox). Leaves `fromId`
 * now (local relink), MOVEs that copy at `dueAt` unless undone.
 */
export function enqueueMove(
  accountId: string,
  messageId: string,
  fromId: string,
  dest: { id: string; role: FolderRole },
  dueAt: number,
): string {
  const { id } = enqueueIntent(accountId, 'move', messageId, dueAt, () =>
    applyMove(messageId, fromId, dest.id),
  );
  emitSignal({ type: 'mail:moved', accountId, messageId, role: dest.role });
  return id;
}

/**
 * Read/star: set the flags locally now and STORE them on the server right away (due now, then
 * nudged). Returns the resulting local flags.
 */
export function enqueueFlags(
  accountId: string,
  messageId: string,
  set: FlagSet,
): { seen: boolean; flagged: boolean } {
  enqueueIntent(accountId, 'flags', messageId, Date.now(), () => applyFlags(messageId, set));
  const flags = currentFlags(messageId) ?? { seen: false, flagged: false };
  emitSignal({ type: 'mail:flags', accountId, messageId, ...flags });
  nudgeOutbox();
  return flags;
}

interface IntentRow {
  id: string;
  accountId: string;
  kind: OutboxKind;
  messageId: string | null;
  payload: string | null;
}

/**
 * Apply an intent's inverse (undo, or the provider never took it) and tell clients what the
 * message looks like now. Runs in one transaction so a half-reverted relink can't be observed.
 */
function revertIntent(row: IntentRow): void {
  const messageId = row.messageId;
  if (!messageId || row.kind === 'send') return;
  const changed = withWriteRetry('outbox.revert', () =>
    db.transaction(() => {
      switch (row.kind) {
        case 'delete':
          return revertDelete(messageId, parsePayload<DeletePayload>(row.payload));
        case 'archive':
        case 'move':
          return revertMove(messageId, parsePayload<MovePayload>(row.payload));
        case 'flags':
          return revertFlags(row.id, messageId, parsePayload<FlagsPayload>(row.payload));
        default:
          return false;
      }
    }),
  );
  if (!changed) return;
  if (row.kind === 'flags') {
    const flags = currentFlags(messageId);
    if (flags) emitSignal({ type: 'mail:flags', accountId: row.accountId, messageId, ...flags });
  } else {
    emitSignal({ type: 'mail:restored', accountId: row.accountId, messageId });
  }
}

export type CancelOutcome = 'canceled' | 'too-late' | 'not-found';

/**
 * Cancel (undo) a pending action. Wins the race against the runner via an atomic
 * `pending`→`canceled` flip: if the runner already claimed it (now `sending`/`done`), the
 * update changes 0 rows and we report `too-late`. A canceled mailbox intent applies its inverse
 * (`mail:restored` / `mail:flags`), so every client shows the message as it was.
 * A canceled SEND is saved back to \Drafts so the composition isn't lost — the composer has
 * already navigated away and cleared its local draft, so the server-side \Drafts copy is the
 * only place the message survives (and it then syncs to every device).
 */
export function cancelOutbox(id: string): CancelOutcome {
  const row = db
    .select({
      id: outbox.id,
      kind: outbox.kind,
      accountId: outbox.accountId,
      messageId: outbox.messageId,
      payload: outbox.payload,
    })
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

  revertIntent(row);

  if (row.kind === 'send' && row.payload) {
    const engine = getEngine(row.accountId);
    if (engine) {
      try {
        const req = JSON.parse(row.payload) as SendMessageRequest;
        void saveDraft(engine.accountConfig, req)
          .then((r) => {
            // Surface the restored draft promptly instead of waiting for the next cron pass.
            if (r.savedToDrafts) engine.reconcileFoldersNow();
          })
          .catch((err: Error) => log.warn(`undo-send draft save failed: ${err.message}`));
      } catch {
        /* malformed payload — nothing to preserve */
      }
    }
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

interface DueRow extends IntentRow {
  attempts: number;
}

/**
 * Claim a bounded snapshot of due pending rows (dueAt + backoff gates honoured), oldest first.
 * Ties break on insertion order so stacked toggles of one flag execute in the order made.
 */
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
    .orderBy(asc(outbox.dueAt), sql`${outbox}.rowid`)
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

const ACTION_OF: Partial<Record<OutboxKind, MailboxAction>> = {
  delete: 'delete',
  archive: 'archive',
  move: 'move',
  flags: 'flags',
};

/**
 * Record a failed attempt: bump `attempts` and either re-arm as `pending` with linear backoff
 * (status returns to pending so the next due scan re-claims it) or park as `dead` at the cap.
 * A terminal send emits `mail:send-failed` so the user learns it never went out; a terminal
 * mailbox intent applies its inverse and emits `mail:action-failed`.
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
  if (!terminal) return;
  if (row.kind === 'send') {
    emitSignal({
      type: 'mail:send-failed',
      accountId: row.accountId,
      outboxId: row.id,
      error: message.slice(0, 200),
    });
    return;
  }
  revertIntent(row);
  const action = ACTION_OF[row.kind];
  if (action) {
    emitSignal({
      type: 'mail:action-failed',
      accountId: row.accountId,
      action,
      count: 1,
      error: message.slice(0, 200),
    });
  }
}

/** Execute one claimed send/delete/archive/move row. Throws on a retryable failure. */
async function execute(row: DueRow): Promise<void> {
  if (row.kind === 'send') {
    const engine = requireEngine(row.accountId);
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
    // No trash folder — the local tombstone stands.
    if (trash) await moveOrRelink(row, row.messageId, serverPlacement(row.messageId), trash);
    markDone(row.id);
    return;
  }

  if (row.kind === 'archive' || row.kind === 'move') {
    // Only the source copy moves (the inbox, for archive); a message no longer there is
    // already elsewhere.
    const dest = moveDest(row);
    if (dest) await moveOrRelink(row, row.messageId, dest.placement, dest.folder);
    markDone(row.id);
    // Gmail drops every other label when a message enters Spam (and gives them back on the way
    // out); reconcile now so label views agree without waiting for the next cron pass.
    if (dest && row.kind === 'move') getEngine(row.accountId)?.reconcileFoldersNow();
  }
}

/**
 * Where an archive or move goes from and to. The enqueue already took the message out of the
 * source folder locally, so the source copy's UID comes from the intent's payload, not from the
 * mappings. An archive queued before intents existed carries no payload and still has its inbox
 * mapping.
 */
function moveDest(
  row: DueRow,
): { placement: ServerPlacement; folder: { id: string; path: string } } | null {
  const messageId = row.messageId!;
  const p = parsePayload<MovePayload>(row.payload);
  if (!p) {
    if (row.kind !== 'archive') return null;
    const inbox = folderByRole(row.accountId, 'inbox');
    const archive = folderByRole(row.accountId, 'archive');
    if (!inbox || !archive) return null;
    const loc = serverPlacement(messageId, inbox.id);
    if (loc.kind === 'unplaced') return null;
    return { placement: loc, folder: archive };
  }
  if (!p.from) return null;
  const path = (id: string) =>
    db.select({ path: folders.path }).from(folders).where(eq(folders.id, id)).get()?.path;
  const destPath = path(p.destId);
  if (!destPath) return null;
  const folder = { id: p.destId, path: destPath };
  if (isMessageLocalOnly(messageId)) return { placement: { kind: 'local-only' }, folder };
  const fromPath = path(p.from.folderId);
  if (p.from.uid === null || !fromPath) return { placement: { kind: 'unplaced' }, folder };
  return {
    placement: { kind: 'server', accountId: row.accountId, folderPath: fromPath, uid: p.from.uid },
    folder,
  };
}

/**
 * Put a message in `dest`. A server copy is MOVEd (which relinks locally). A detached message
 * has no server copy, so the local relink IS the action — the same purely local move the cleanup
 * trash queue gives it — and nothing will reconcile it later, so announce the destination here.
 */
async function moveOrRelink(
  row: DueRow,
  messageId: string,
  placement: ServerPlacement,
  dest: { id: string; path: string },
): Promise<void> {
  switch (placement.kind) {
    case 'server':
      if (placement.folderPath === dest.path) return;
      await moveToFolderOnServer(
        requireEngine(row.accountId).accountConfig,
        messageId,
        placement,
        dest,
      );
      return;
    case 'local-only':
      relinkMessageToFolder(messageId, dest.id, null);
      emitSignal({ type: 'mail:folder', accountId: row.accountId, folderId: dest.id });
      return;
    case 'unplaced':
      return; // nothing on the server to move
  }
}

const IMAP_FLAG: Record<FlagName, FlagStore['flag']> = { seen: '\\Seen', flagged: '\\Flagged' };

/**
 * Where a flag STORE has to go. An archive or move relinks the message locally when it is
 * enqueued but MOVEs it only when it runs, so until then the server copy is still in the source
 * folder, which the message no longer maps to. Without this, a read flag set together with a
 * move (a rule that marks read and moves to spam, or unread just after Report spam) found no
 * placement, was marked done without reaching the server, and the next sync of the destination
 * undid it. Rows run one drain at a time, so a pending or claimed-but-unrun move hasn't moved yet.
 */
export function flagPlacement(messageId: string): ServerPlacement {
  if (isMessageLocalOnly(messageId)) return { kind: 'local-only' };
  const moving = db
    .select({ payload: outbox.payload })
    .from(outbox)
    .where(
      and(
        eq(outbox.messageId, messageId),
        inArray(outbox.kind, ['archive', 'move']),
        inArray(outbox.status, ['pending', 'sending']),
      ),
    )
    .orderBy(sql`${outbox}.rowid`)
    .get();
  const from = parsePayload<MovePayload>(moving?.payload ?? null)?.from;
  if (from?.uid != null) {
    const src = db
      .select({ accountId: folders.accountId, path: folders.path })
      .from(folders)
      .where(eq(folders.id, from.folderId))
      .get();
    if (src)
      return { kind: 'server', accountId: src.accountId, folderPath: src.path, uid: from.uid };
  }
  return serverPlacement(messageId);
}

/**
 * Execute claimed flags rows as batched STOREs: one transient connection per account and one
 * STORE per (folder, flag, value). Rows are in insertion order, so when several set the same
 * flag on the same message the last one decides the value sent, and all of them share its
 * outcome. Detached or unplaced mail has no server copy — the local write was the whole action.
 */
async function executeFlags(rows: DueRow[], now: Date): Promise<number> {
  interface Group {
    store: FlagStore;
    rowIds: Set<string>;
  }
  const failed = new Map<string, string>();
  // Per account: `${messageId}\0${flag}` → the final value and every row that touched it.
  const perAccount = new Map<
    string,
    Map<string, { value: boolean; path: string; uid: number; rowIds: string[] }>
  >();

  for (const row of rows) {
    const p = parsePayload<FlagsPayload>(row.payload);
    const loc = row.messageId && p ? flagPlacement(row.messageId) : { kind: 'unplaced' as const };
    if (loc.kind !== 'server' || !p) continue; // marked done below
    let finals = perAccount.get(row.accountId);
    if (!finals) perAccount.set(row.accountId, (finals = new Map()));
    for (const f of Object.keys(IMAP_FLAG) as FlagName[]) {
      const value = p.set[f];
      if (value === undefined) continue;
      const key = `${row.messageId}\u0000${f}`;
      const prior = finals.get(key);
      finals.set(key, {
        value,
        path: loc.folderPath,
        uid: loc.uid,
        rowIds: [...(prior?.rowIds ?? []), row.id],
      });
    }
  }

  for (const [accountId, finals] of perAccount) {
    const groups = new Map<string, Group>();
    for (const [key, fin] of finals) {
      const flag = IMAP_FLAG[key.slice(key.indexOf('\u0000') + 1) as FlagName];
      const gk = `${fin.path}\u0000${flag}\u0000${fin.value}`;
      let g = groups.get(gk);
      if (!g) {
        g = {
          store: { folderPath: fin.path, flag, value: fin.value, uids: [] },
          rowIds: new Set(),
        };
        groups.set(gk, g);
      }
      g.store.uids.push(fin.uid);
      for (const id of fin.rowIds) g.rowIds.add(id);
    }
    const list = [...groups.values()];
    let results: (string | null)[];
    try {
      results = await storeFlagsOnServer(
        requireEngine(accountId).accountConfig,
        list.map((g) => g.store),
      );
    } catch (err) {
      results = list.map(() => (err as Error).message);
    }
    list.forEach((g, i) => {
      const error = results[i];
      for (const id of g.rowIds) if (error) failed.set(id, error);
    });
    // A star changes membership of a flag-derived folder (Gmail's [Gmail]/Starred): reconcile
    // non-INBOX folders now so it shows there right away rather than after the next cron pass.
    if (list.some((g, i) => g.store.flag === '\\Flagged' && !results[i])) {
      getEngine(accountId)?.reconcileFoldersNow();
    }
  }

  // Oldest first, so a dead intent hands its inverse down to a newer one (intents.revertFlags).
  let executed = 0;
  for (const row of rows) {
    const error = failed.get(row.id);
    if (error) {
      log.warn(`flags ${row.id} failed: ${error}`);
      markFailed(row, error, now);
    } else {
      markDone(row.id);
      executed += 1;
    }
  }
  return executed;
}

function requireEngine(accountId: string): NonNullable<ReturnType<typeof getEngine>> {
  const engine = getEngine(accountId);
  if (!engine) throw new Error(`no engine for account ${accountId} (not ready yet)`);
  return engine;
}

/**
 * Process one bounded snapshot of due work. Returns the number of rows executed this pass.
 * Never throws — per-row failures are recorded as backoff/dead so one bad action can't stall
 * the rest. Each row is atomically claimed first, so a row canceled between claimDue and claim
 * is simply skipped. Flag rows go first, batched: they're what the user is looking at.
 */
export async function runOutboxOnce(): Promise<number> {
  const now = new Date();
  const due = claimDue(now, BATCH).filter((row) => claim(row.id));
  if (due.length === 0) return 0;

  let executed = await executeFlags(
    due.filter((r) => r.kind === 'flags'),
    now,
  );
  for (const row of due) {
    if (row.kind === 'flags') continue;
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

/** Drop finished rows past the retention window — flags make the queue busy enough to grow. */
export function pruneOutbox(now = Date.now()): number {
  return withWriteRetry('outbox.prune', () =>
    db
      .delete(outbox)
      .where(
        and(
          inArray(outbox.status, ['done', 'canceled', 'dead']),
          lt(outbox.updatedAt, new Date(now - RETAIN_MS)),
        ),
      )
      .run(),
  ).changes;
}

let busy = false;
let again = false;

/**
 * Drain the queue, guarding against overlapping runs (interval + post-enqueue nudge). A nudge
 * that lands mid-drain runs one more pass afterwards, so a flag toggled while a slow send is in
 * flight doesn't wait for the next tick.
 */
async function drain(): Promise<void> {
  if (busy) {
    again = true;
    return;
  }
  busy = true;
  try {
    do {
      again = false;
      await runOutboxOnce();
    } while (again);
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

  const prune = () => {
    try {
      const n = pruneOutbox();
      if (n > 0) log.info(`pruned ${n} finished outbox rows`);
    } catch (err) {
      log.warn(`outbox prune failed: ${(err as Error).message}`);
    }
  };
  prune();
  const pruneTimer = setInterval(prune, PRUNE_EVERY_MS);
  if (typeof pruneTimer.unref === 'function') pruneTimer.unref();
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
