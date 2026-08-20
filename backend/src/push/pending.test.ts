/**
 * The APK's only way to be woken, so the two things that make it trustworthy are pinned
 * here:
 *
 * 1. **The credential.** A device secret is minted once and only its hash is stored, so
 *    a leaked DB (or backup) cannot be replayed against the poll.
 * 2. **The cursor.** Nothing queues for a device between polls; the server answers each
 *    one from what the device has not been told about yet. A cursor that failed to
 *    advance would re-notify the same mail every few minutes, and one that ran ahead
 *    would silently swallow arrivals.
 *
 * `client.ts` opens the DB at import from `env.dbPath`, so MAILY_DATA_DIR is pointed at
 * a temp dir BEFORE the dynamic imports — same shape as db/migrate.test.ts.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import type Database from 'better-sqlite3';
// Namespace type-imports only: the modules themselves must be imported *after*
// MAILY_DATA_DIR is set below, since db/client.ts opens the DB at import time.
import type * as Devices from './devices.js';
import type * as Pending from './pending.js';
import type * as Queries from '../db/queries.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'maily-push-pending-test-'));
process.env.MAILY_DATA_DIR = tmpRoot;

let sqlite: Database.Database;
let devices: typeof Devices;
let pending: typeof Pending;
let queries: typeof Queries;

before(async () => {
  const client = await import('../db/client.js');
  const { runMigrations } = await import('../db/migrate.js');
  runMigrations();
  sqlite = client.sqlite;
  devices = await import('./devices.js');
  pending = await import('./pending.js');
  queries = await import('../db/queries.js');
});

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Insert an unseen INBOX message, since the poll reads the real query. */
function seedInboxMessage(receivedAt: number): string {
  const accountId = randomUUID();
  const folderId = randomUUID();
  const messageId = randomUUID();
  sqlite
    .prepare(
      `INSERT INTO accounts (id, email, provider, imap_host, smtp_host)
       VALUES (?, ?, 'imap', 'imap.test', 'smtp.test')`,
    )
    .run(accountId, `${accountId}@test.invalid`);
  sqlite
    .prepare(
      `INSERT INTO folders (id, account_id, path, name, role) VALUES (?, ?, 'INBOX', 'Inbox', 'inbox')`,
    )
    .run(folderId, accountId);
  sqlite
    .prepare(
      `INSERT INTO messages (id, account_id, subject, from_address, received_at, seen)
       VALUES (?, ?, 'Seeded', 'sender@test.invalid', ?, 0)`,
    )
    .run(messageId, accountId, receivedAt);
  sqlite
    .prepare(`INSERT INTO message_folders (message_id, folder_id) VALUES (?, ?)`)
    .run(messageId, folderId);
  return messageId;
}

/** Poll as the device would: authenticate the stored secret, then ask what is pending. */
function poll(token: string): string[] {
  const device = devices.deviceForAuthHeader(`Bearer ${token}`);
  assert.ok(device, 'the device secret authenticates');
  return pending.pendingForDevice(device).map((n) => n.messageId);
}

test('a minted device token authenticates, and only its hash is stored', () => {
  const token = devices.issueDeviceToken('android');
  const device = devices.deviceForAuthHeader(`Bearer ${token}`);
  assert.ok(device, 'the freshly minted secret authenticates');

  const stored = sqlite
    .prepare(`SELECT token_hash FROM push_devices WHERE id = ?`)
    .get(device.id) as { token_hash: string };
  assert.notEqual(stored.token_hash, token, 'the plaintext secret is never stored');
  assert.equal(stored.token_hash, devices.hashDeviceToken(token));

  assert.equal(devices.deviceForAuthHeader(`Bearer ${token}x`), null, 'a near-miss is rejected');
  assert.equal(devices.deviceForAuthHeader(token), null, 'a bare token without Bearer is rejected');
  assert.equal(devices.deviceForAuthHeader(undefined), null);

  devices.revokeDeviceToken(token);
  assert.equal(devices.deviceForAuthHeader(`Bearer ${token}`), null, 'revocation takes effect');
});

test('a device that just registered is not flooded with mail it already has', () => {
  seedInboxMessage(Date.now() - 120_000);
  const token = devices.issueDeviceToken('android');
  assert.deepEqual(
    poll(token),
    [],
    'turning notifications on is not a request to be told about the existing inbox',
  );
});

test('a poll returns the arrivals missed since the last one, exactly once', () => {
  const token = devices.issueDeviceToken('android');
  const hash = devices.hashDeviceToken(token);
  const receivedAt = Date.now() - 60_000;
  const messageId = seedInboxMessage(receivedAt);
  // Wind the cursor back behind that arrival, but ahead of the older message the previous
  // test seeded: this device has polled before, and was asleep when *this* mail landed.
  sqlite
    .prepare(`UPDATE push_devices SET last_event_at = ? WHERE token_hash = ?`)
    .run(receivedAt - 30_000, hash);

  assert.deepEqual(poll(token), [messageId], 'mail that arrived since the last poll is offered');
  assert.equal(queries.pushDeviceByHash(hash)?.lastEventAt, receivedAt);
  assert.deepEqual(poll(token), [], 'the cursor stops it being offered again');
});

test('mail read on another client is no longer worth a notification', () => {
  const token = devices.issueDeviceToken('android');
  const hash = devices.hashDeviceToken(token);
  const receivedAt = Date.now() - 45_000;
  const messageId = seedInboxMessage(receivedAt);
  sqlite
    .prepare(`UPDATE push_devices SET last_event_at = ? WHERE token_hash = ?`)
    .run(receivedAt - 30_000, hash);
  sqlite.prepare(`UPDATE messages SET seen = 1 WHERE id = ?`).run(messageId);

  assert.ok(!poll(token).includes(messageId), 'reading it elsewhere withdraws the notification');
});

test('the cursor never runs backwards', () => {
  const token = devices.issueDeviceToken('android');
  const hash = devices.hashDeviceToken(token);
  const device = devices.deviceForAuthHeader(`Bearer ${token}`)!;
  const later = Date.now() + 9000;

  queries.advancePushDeviceCursor(device.id, later);
  queries.advancePushDeviceCursor(device.id, later - 5000);
  assert.equal(
    queries.pushDeviceByHash(hash)?.lastEventAt,
    later,
    'an out-of-order write cannot drag the cursor back',
  );
});
