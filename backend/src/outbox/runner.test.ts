/**
 * Outbox runner coverage. Pins the parts that don't touch IMAP/SMTP:
 *  - the `dueAt` gate: a not-yet-due row isn't claimed,
 *  - cancel (the server-owned undo): a pending row flips to `canceled`, a delete's tombstone is
 *    cleared, and a non-pending row reports `too-late` (the runner already owns it),
 *  - the claim + backoff: with no engine registered a due delete can't MOVE, so it stays
 *    pending with a future backoff gate,
 *  - mailbox intents: each applies its local effect at enqueue, and cancel or `dead` applies
 *    the inverse — including stacked flag toggles that all fail,
 *  - listPendingSends surfaces the queued send's subject/recipients.
 * The IMAP MOVE and SMTP send themselves ride the manually-verified imap/move.ts + mail/send.ts.
 *
 * Same throwaway-DB bootstrap as trashQueue.test.ts (point MAILY_DATA_DIR before the dynamic
 * import, then migrate so the outbox table + its FK to messages exist).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import test, { after, before, beforeEach } from 'node:test';
import type * as SchemaNS from '../db/schema.js';
import type * as DbClientNS from '../db/client.js';
import type * as RunnerNS from './runner.js';
import type * as EventsNS from '../events.js';
import type { SocketSignal } from '@maily/shared';

const tmpRoot = mkdtempSync(join(tmpdir(), 'maily-outbox-test-'));
process.env.MAILY_DATA_DIR = tmpRoot;

let db: (typeof DbClientNS)['db'];
let schema: typeof SchemaNS;
let R: typeof RunnerNS;
let onSignal: (typeof EventsNS)['onSignal'];

before(async () => {
  const client = await import('../db/client.js');
  const { runMigrations } = await import('../db/migrate.js');
  runMigrations();
  db = client.db;
  schema = await import('../db/schema.js');
  R = await import('./runner.js');
  ({ onSignal } = await import('../events.js'));
});

after(() => rmSync(tmpRoot, { recursive: true, force: true }));

beforeEach(() => {
  db.delete(schema.outbox).run();
  db.delete(schema.messageFolders).run();
  db.delete(schema.messages).run();
  db.delete(schema.folders).run();
  db.delete(schema.accounts).run();
});

function seedAccount(): string {
  const accountId = randomUUID();
  db.insert(schema.accounts)
    .values({
      id: accountId,
      email: 'a@me.example',
      provider: 'imap',
      imapHost: 'i',
      smtpHost: 's',
    })
    .run();
  return accountId;
}

function seedMessage(accountId: string, opts: { deleted?: boolean } = {}): string {
  const id = randomUUID();
  db.insert(schema.messages)
    .values({
      id,
      accountId,
      fromAddress: 'x@y.example',
      deletedAt: opts.deleted ? new Date() : null,
    })
    .run();
  return id;
}

test('dueAt gate: a not-yet-due action is not claimed', async () => {
  const accountId = seedAccount();
  const msg = seedMessage(accountId, { deleted: true });
  R.enqueueDelete(accountId, msg, Date.now() + 60_000); // due in a minute

  assert.equal(await R.runOutboxOnce(), 0, 'nothing executed before dueAt');
  const row = db.select().from(schema.outbox).where(eq(schema.outbox.messageId, msg)).get();
  assert.equal(row!.status, 'pending', 'stays pending until its window elapses');
  assert.equal(row!.attempts, 0, 'not attempted');
});

test('cancel: pending delete flips to canceled and clears the tombstone', () => {
  const accountId = seedAccount();
  const msg = seedMessage(accountId);
  const id = R.enqueueDelete(accountId, msg, Date.now() + 60_000);
  const tombstoned = db.select().from(schema.messages).where(eq(schema.messages.id, msg)).get();
  assert.notEqual(tombstoned!.deletedAt, null, 'the enqueue tombstoned it');

  assert.equal(R.cancelOutbox(id), 'canceled');
  const row = db.select().from(schema.outbox).where(eq(schema.outbox.id, id)).get();
  assert.equal(row!.status, 'canceled');
  const m = db.select().from(schema.messages).where(eq(schema.messages.id, msg)).get();
  assert.equal(m!.deletedAt, null, 'undo restored the message (tombstone cleared)');
});

test('cancel: unknown id → not-found; already-committed row → too-late', () => {
  const accountId = seedAccount();
  assert.equal(R.cancelOutbox(randomUUID()), 'not-found');

  const id = R.enqueueSend(accountId, { to: ['x@y.example'], subject: 'hi' }, Date.now() + 60_000);
  db.update(schema.outbox).set({ status: 'done' }).where(eq(schema.outbox.id, id)).run();
  assert.equal(R.cancelOutbox(id), 'too-late', 'cannot undo once the runner has committed it');
});

test('due delete with no engine → backoff, stays pending with a future gate', async () => {
  const accountId = seedAccount();
  const msg = seedMessage(accountId, { deleted: true });
  const inbox = randomUUID();
  db.insert(schema.folders)
    .values([
      { id: inbox, accountId, path: 'INBOX', name: 'Inbox', role: 'inbox' },
      { id: randomUUID(), accountId, path: 'Trash', name: 'Trash', role: 'trash' },
    ])
    .run();
  db.insert(schema.messageFolders).values({ messageId: msg, folderId: inbox, uid: 3 }).run();
  R.enqueueDelete(accountId, msg, Date.now() - 1_000); // already due

  // A server copy to MOVE, but no engine registered in this test process.
  assert.equal(await R.runOutboxOnce(), 0, 'nothing committed without an engine');
  const row = db.select().from(schema.outbox).where(eq(schema.outbox.messageId, msg)).get();
  assert.equal(row!.status, 'pending', 'retryable — back to pending');
  assert.equal(row!.attempts, 1, 'attempt counted');
  assert.ok(row!.nextAttemptAt && row!.nextAttemptAt.getTime() > Date.now(), 'backoff gate armed');
  assert.equal(await R.runOutboxOnce(), 0, 'not re-claimed before the gate passes');
});

/** Detached (local_only) mail mapped into `role`'s folder, with its stale pre-detach UID. */
function seedDetached(accountId: string, role: 'inbox' | 'archive', deleted: boolean) {
  const folderIds = Object.fromEntries(
    (['inbox', 'archive', 'trash'] as const).map((r) => {
      const id = randomUUID();
      db.insert(schema.folders).values({ id, accountId, path: r, name: r, role: r }).run();
      return [r, id];
    }),
  ) as Record<'inbox' | 'archive' | 'trash', string>;
  const msg = seedMessage(accountId, { deleted });
  db.update(schema.messages).set({ localOnly: true }).where(eq(schema.messages.id, msg)).run();
  db.insert(schema.messageFolders)
    .values({ messageId: msg, folderId: folderIds[role], uid: 7 })
    .run();
  return { msg, folderIds };
}

function mappings(msg: string) {
  return db
    .select({ folderId: schema.messageFolders.folderId, uid: schema.messageFolders.uid })
    .from(schema.messageFolders)
    .where(eq(schema.messageFolders.messageId, msg))
    .all();
}

test('due delete of detached mail relinks it into Trash locally — no engine needed', async () => {
  const accountId = seedAccount();
  const { msg, folderIds } = seedDetached(accountId, 'inbox', false);
  const signals: SocketSignal[] = [];
  const off = onSignal((s) => signals.push(s));
  R.enqueueDelete(accountId, msg, Date.now() - 1_000);

  assert.equal(await R.runOutboxOnce(), 1);
  off();
  assert.deepEqual(mappings(msg), [{ folderId: folderIds.trash, uid: null }], 'shows up in Trash');
  assert.deepEqual(signals, [
    { type: 'mail:deleted', accountId, messageId: msg },
    { type: 'mail:folder', accountId, folderId: folderIds.trash },
  ]);
  const row = db.select().from(schema.outbox).where(eq(schema.outbox.messageId, msg)).get();
  assert.equal(row!.status, 'done');
});

test('due archive of detached mail relinks the inbox copy into Archive; elsewhere is left alone', async () => {
  const accountId = seedAccount();
  const { msg, folderIds } = seedDetached(accountId, 'inbox', false);
  R.enqueueArchive(accountId, msg, folderIds.archive, Date.now() - 1_000);
  assert.deepEqual(mappings(msg), [{ folderId: folderIds.archive, uid: null }], 'left at enqueue');
  assert.equal(await R.runOutboxOnce(), 1);
  assert.deepEqual(mappings(msg), [{ folderId: folderIds.archive, uid: null }]);

  const other = seedAccount();
  const archived = seedDetached(other, 'archive', false);
  R.enqueueArchive(other, archived.msg, archived.folderIds.archive, Date.now() - 1_000);
  assert.equal(await R.runOutboxOnce(), 1);
  assert.deepEqual(
    mappings(archived.msg),
    [{ folderId: archived.folderIds.archive, uid: 7 }],
    'not in the inbox — nothing to archive',
  );
});

/** A server-placed message in the inbox (UID 3), plus the account's archive and trash folders. */
function seedInInbox(opts: { deleted?: boolean; seen?: boolean; flagged?: boolean } = {}) {
  const accountId = seedAccount();
  const f = {
    inbox: randomUUID(),
    archive: randomUUID(),
    trash: randomUUID(),
    label: randomUUID(),
  };
  db.insert(schema.folders)
    .values([
      { id: f.inbox, accountId, path: 'INBOX', name: 'Inbox', role: 'inbox' },
      { id: f.archive, accountId, path: 'Archive', name: 'Archive', role: 'archive' },
      { id: f.trash, accountId, path: 'Trash', name: 'Trash', role: 'trash' },
      { id: f.label, accountId, path: 'Work', name: 'Work', role: 'custom' },
    ])
    .run();
  const msg = seedMessage(accountId, { deleted: opts.deleted });
  db.update(schema.messages)
    .set({ seen: opts.seen ?? false, flagged: opts.flagged ?? false })
    .where(eq(schema.messages.id, msg))
    .run();
  db.insert(schema.messageFolders).values({ messageId: msg, folderId: f.inbox, uid: 3 }).run();
  return { accountId, msg, f };
}

/** Put every pending row on its last attempt with the backoff gate open. */
function lastAttempt(): void {
  db.update(schema.outbox)
    .set({ attempts: 4, nextAttemptAt: null })
    .where(eq(schema.outbox.status, 'pending'))
    .run();
}

function flagsOf(msg: string) {
  return db
    .select({ seen: schema.messages.seen, flagged: schema.messages.flagged })
    .from(schema.messages)
    .where(eq(schema.messages.id, msg))
    .get();
}

test('archive leaves the inbox at enqueue; cancel puts it back', () => {
  const { accountId, msg, f } = seedInInbox();
  db.insert(schema.messageFolders).values({ messageId: msg, folderId: f.label, uid: 11 }).run();
  const id = R.enqueueArchive(accountId, msg, f.archive, Date.now() + 60_000);

  const byFolder = (rows: { folderId: string; uid: number | null }[]) =>
    [...rows].sort((a, b) => a.folderId.localeCompare(b.folderId));
  assert.deepEqual(
    byFolder(mappings(msg)),
    byFolder([
      { folderId: f.archive, uid: null },
      { folderId: f.label, uid: 11 },
    ]),
    'out of the inbox at once; other labels untouched',
  );

  assert.equal(R.cancelOutbox(id), 'canceled');
  assert.deepEqual(
    byFolder(mappings(msg)),
    byFolder([
      { folderId: f.inbox, uid: 3 },
      { folderId: f.label, uid: 11 },
    ]),
    'back in the inbox with its UID; placeholder archive mapping gone',
  );
});

test('archive that goes dead is taken back and reported', async () => {
  const { accountId, msg, f } = seedInInbox();
  R.enqueueArchive(accountId, msg, f.archive, Date.now() - 1_000);
  lastAttempt();

  const signals: SocketSignal[] = [];
  const off = onSignal((s) => signals.push(s));
  assert.equal(await R.runOutboxOnce(), 0, 'no engine — the MOVE fails');
  off();

  const row = db.select().from(schema.outbox).where(eq(schema.outbox.messageId, msg)).get();
  assert.equal(row!.status, 'dead');
  assert.deepEqual(mappings(msg), [{ folderId: f.inbox, uid: 3 }], 'still in the inbox');
  assert.deepEqual(
    signals.map((s) => s.type),
    ['mail:restored', 'mail:action-failed'],
  );
});

test('delete that goes dead clears its tombstone — unless it was already tombstoned', async () => {
  const live = seedInInbox();
  R.enqueueDelete(live.accountId, live.msg, Date.now() - 1_000);
  const pre = seedInInbox({ deleted: true });
  R.enqueueDelete(pre.accountId, pre.msg, Date.now() - 1_000);
  lastAttempt();
  await R.runOutboxOnce();

  const deletedAt = (id: string) =>
    db.select().from(schema.messages).where(eq(schema.messages.id, id)).get()!.deletedAt;
  assert.equal(deletedAt(live.msg), null, 'the provider still has it in the inbox');
  assert.notEqual(deletedAt(pre.msg), null, 'the inverse only takes back what this delete did');
});

test('flags apply at enqueue and a dead STORE reverts them', async () => {
  const { accountId, msg } = seedInInbox();
  assert.deepEqual(R.enqueueFlags(accountId, msg, { seen: true }), {
    seen: true,
    flagged: false,
  });
  assert.deepEqual(flagsOf(msg), { seen: true, flagged: false }, 'local at once');

  lastAttempt();
  const signals: SocketSignal[] = [];
  const off = onSignal((s) => signals.push(s));
  await R.runOutboxOnce();
  off();

  assert.deepEqual(flagsOf(msg), { seen: false, flagged: false }, 'reverted');
  assert.deepEqual(signals, [
    { type: 'mail:flags', accountId, messageId: msg, seen: false, flagged: false },
    {
      type: 'mail:action-failed',
      accountId,
      action: 'flags',
      count: 1,
      error: `no engine for account ${accountId} (not ready yet)`,
    },
  ]);
});

test('stacked flag toggles that all fail end on the original value', async () => {
  const { accountId, msg } = seedInInbox();
  R.enqueueFlags(accountId, msg, { seen: true });
  R.enqueueFlags(accountId, msg, { seen: false });
  R.enqueueFlags(accountId, msg, { seen: true, flagged: true });
  assert.deepEqual(flagsOf(msg), { seen: true, flagged: true });

  lastAttempt();
  await R.runOutboxOnce();
  assert.deepEqual(flagsOf(msg), { seen: false, flagged: false }, 'what the provider still has');
  const statuses = db.select({ s: schema.outbox.status }).from(schema.outbox).all();
  assert.deepEqual(
    statuses.map((r) => r.s),
    ['dead', 'dead', 'dead'],
  );
});

test('a dead flag intent leaves a value that a newer, landed intent set', async () => {
  const { accountId, msg } = seedInInbox();
  R.enqueueFlags(accountId, msg, { seen: true });
  lastAttempt();
  // A newer intent for the same flag already reached the server.
  R.enqueueFlags(accountId, msg, { seen: true });
  const rows = db
    .select({ id: schema.outbox.id })
    .from(schema.outbox)
    .orderBy(sql`rowid`)
    .all();
  db.update(schema.outbox).set({ status: 'done' }).where(eq(schema.outbox.id, rows[1]!.id)).run();

  await R.runOutboxOnce();
  assert.deepEqual(flagsOf(msg), { seen: true, flagged: false }, 'the landed intent owns it');
});

test('flags on detached mail finish without a server — the local write is the action', async () => {
  const accountId = seedAccount();
  const { msg } = seedDetached(accountId, 'inbox', false);
  R.enqueueFlags(accountId, msg, { flagged: true });
  await new Promise((r) => setImmediate(r)); // the enqueue nudged the runner, which claimed it
  assert.deepEqual(flagsOf(msg), { seen: false, flagged: true });
  const row = db.select().from(schema.outbox).get();
  assert.equal(row!.status, 'done');
});

test('pruneOutbox drops finished rows past retention, keeps pending ones', () => {
  const accountId = seedAccount();
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  R.enqueueSend(accountId, { to: ['x@y.example'], subject: 'a' }, Date.now() + 60_000);
  const done = R.enqueueSend(accountId, { to: ['x@y.example'], subject: 'b' }, Date.now());
  db.update(schema.outbox).set({ updatedAt: old }).run();
  db.update(schema.outbox).set({ status: 'done' }).where(eq(schema.outbox.id, done)).run();

  assert.equal(R.pruneOutbox(), 1);
  assert.equal(R.pendingSendCount(), 1, 'a pending row is never pruned, however old');
});

test('listPendingSends surfaces queued sends with subject/recipients', () => {
  const accountId = seedAccount();
  R.enqueueSend(
    accountId,
    { to: ['a@x.example', 'b@x.example'], subject: 'Later' },
    Date.now() + 9e5,
  );
  const entries = R.listPendingSends();
  assert.equal(entries.length, 1);
  const e = entries[0]!;
  assert.equal(e.kind, 'send');
  assert.equal(e.subject, 'Later');
  assert.deepEqual(e.to, ['a@x.example', 'b@x.example']);
  assert.equal(R.pendingSendCount(), 1);
});
