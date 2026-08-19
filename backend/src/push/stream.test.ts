/**
 * The self-hosted push transport — the APK's only way to be woken, so the two things
 * that make it trustworthy are pinned here:
 *
 * 1. **The credential.** A device secret is minted once and only its hash is stored, so
 *    a leaked DB (or backup) cannot be replayed against the stream.
 * 2. **The catch-up cursor.** Unlike FCM, nothing queues for a device that is offline;
 *    the server replays what it missed on reconnect. A cursor that failed to advance
 *    would re-notify the same mail on every reconnect, and one that ran ahead would
 *    silently swallow arrivals.
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
import { PassThrough } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
// Namespace type-imports only: the modules themselves must be imported *after*
// MAILY_DATA_DIR is set below, since db/client.ts opens the DB at import time.
import type * as Devices from './devices.js';
import type * as Stream from './stream.js';
import type * as Queries from '../db/queries.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'maily-push-stream-test-'));
process.env.MAILY_DATA_DIR = tmpRoot;

let sqlite: Database.Database;
let devices: typeof Devices;
let stream: typeof Stream;
let queries: typeof Queries;

before(async () => {
  const client = await import('../db/client.js');
  const { runMigrations } = await import('../db/migrate.js');
  runMigrations();
  sqlite = client.sqlite;
  devices = await import('./devices.js');
  stream = await import('./stream.js');
  queries = await import('../db/queries.js');
});

after(() => {
  stream.stopStreamHub();
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * A stand-in for the hijacked reply/request pair. `raw` only has to be a writable the
 * hub can push frames at and a source of the 'close' event, which a PassThrough is.
 */
function fakeConnection(): {
  req: FastifyRequest;
  reply: FastifyReply;
  frames: () => string;
  close: () => void;
} {
  const socket = new PassThrough();
  const chunks: string[] = [];
  socket.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
  const raw = Object.assign(socket, { writeHead: () => socket });
  return {
    req: { raw: socket } as unknown as FastifyRequest,
    reply: { hijack: () => undefined, raw } as unknown as FastifyReply,
    frames: () => chunks.join(''),
    close: () => socket.emit('close'),
  };
}

/** Parse the `data:` payloads out of an SSE byte stream, ignoring comments/heartbeats. */
function events(text: string): { messageId: string; receivedAt: number }[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as { messageId: string; receivedAt: number });
}

/** Insert an unseen INBOX message, since catch-up reads the real query. */
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

test('a broadcast reaches connected devices and advances their cursor', () => {
  const token = devices.issueDeviceToken('android');
  const device = devices.deviceForAuthHeader(`Bearer ${token}`)!;
  const connection = fakeConnection();
  stream.attachDeviceStream(device, connection.req, connection.reply);
  assert.equal(stream.connectedDeviceCount(), 1);

  // Newer than the cursor registration seeded, i.e. mail that arrived after this device
  // was set up — the only kind a live broadcast ever carries.
  const receivedAt = Date.now() + 1000;
  stream.broadcastStream({
    title: 'Sender',
    body: 'Subject',
    messageId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    receivedAt,
  });

  assert.deepEqual(
    events(connection.frames()).map((e) => e.messageId),
    ['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'],
  );
  assert.equal(queries.pushDeviceByHash(devices.hashDeviceToken(token))?.lastEventAt, receivedAt);

  connection.close();
  assert.equal(stream.connectedDeviceCount(), 0, 'a closed socket is dropped from the hub');
});

test('a device that just registered is not flooded with mail it already has', () => {
  seedInboxMessage(Date.now() - 120_000);
  const token = devices.issueDeviceToken('android');
  const connection = fakeConnection();

  stream.attachDeviceStream(
    devices.deviceForAuthHeader(`Bearer ${token}`)!,
    connection.req,
    connection.reply,
  );
  assert.deepEqual(
    events(connection.frames()),
    [],
    'turning notifications on is not a request to be told about the existing inbox',
  );
  connection.close();
});

test('reconnecting replays the arrivals missed while offline, exactly once', () => {
  const token = devices.issueDeviceToken('android');
  const hash = devices.hashDeviceToken(token);
  const receivedAt = Date.now() - 60_000;
  const messageId = seedInboxMessage(receivedAt);
  // Wind the cursor back behind that arrival, but ahead of the older message the previous
  // test seeded: this device has connected before, and was away when *this* mail landed.
  sqlite
    .prepare(`UPDATE push_devices SET last_event_at = ? WHERE token_hash = ?`)
    .run(receivedAt - 30_000, hash);

  const first = fakeConnection();
  stream.attachDeviceStream(
    devices.deviceForAuthHeader(`Bearer ${token}`)!,
    first.req,
    first.reply,
  );
  assert.deepEqual(
    events(first.frames()).map((e) => e.messageId),
    [messageId],
    'mail that arrived while the device was away is replayed on connect',
  );
  assert.equal(queries.pushDeviceByHash(hash)?.lastEventAt, receivedAt);
  first.close();

  const second = fakeConnection();
  stream.attachDeviceStream(
    devices.deviceForAuthHeader(`Bearer ${token}`)!,
    second.req,
    second.reply,
  );
  assert.deepEqual(events(second.frames()), [], 'the cursor stops it being replayed again');
  second.close();
});

test('the catch-up cursor never runs backwards', () => {
  const token = devices.issueDeviceToken('android');
  const hash = devices.hashDeviceToken(token);
  const device = devices.deviceForAuthHeader(`Bearer ${token}`)!;
  const later = Date.now() + 9000;

  queries.advancePushDeviceCursor(device.id, later);
  queries.advancePushDeviceCursor(device.id, later - 5000);
  assert.equal(
    queries.pushDeviceByHash(hash)?.lastEventAt,
    later,
    'an out-of-order write cannot drag the cursor back and re-open a replay window',
  );
});
