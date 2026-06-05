/**
 * Characterization net for the protected HTTP API (Refactoring Phase 2 prerequisite).
 * `routes/api.ts` is the 488-LOC god-file the next structural step splits by resource
 * (messages / folders / attachments / actions / contacts). Before moving any route,
 * these tests PIN the observable contract a split must preserve:
 *   - the JWT auth gate (401 without a token),
 *   - DTO shaping of the read routes (accounts, folders, message list + detail),
 *   - pagination param handling (limit honoured),
 *   - the action routes' LOCAL-FIRST behaviour and status codes: flags PATCH / delete
 *     tombstone / archive mutate the local DB and return synchronously; the IMAP
 *     propagation is fire-and-forget and — with no engine registered — is skipped,
 *     so the routes are exercisable without a live connection,
 *   - input validation (settings) and the empty-query short-circuits (search/contacts).
 *
 * They describe today's behaviour, not an ideal — a regression tripwire. Like the other
 * engine tests, `env.ts`/`db/client.ts` reach for `process.env` + the SQLite file at
 * import, so we set the env vars FIRST and dynamically import everything after.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { EmailAddress, FolderRole } from '@maily/shared';
import type * as StoreNS from '../imap/store.js';
import type * as SchemaNS from '../db/schema.js';
import type * as DbClientNS from '../db/client.js';
import type { ParsedMessage } from '../imap/types.js';

// Must be set before the db client / env (transitively) are imported.
const tmpRoot = mkdtempSync(join(tmpdir(), 'maily-api-test-'));
process.env.MAILY_DATA_DIR = tmpRoot;
process.env.JWT_SECRET = 'test-secret';
process.env.MASTER_PASSWORD = 'test-master';

let app: FastifyInstance;
let token: string;
let rawDb: (typeof DbClientNS)['db'];
let schema: typeof SchemaNS;
let store: typeof StoreNS;

before(async () => {
  const { default: Fastify } = await import('fastify');
  const { default: jwt } = await import('@fastify/jwt');
  const { runMigrations } = await import('../db/migrate.js');
  const client = await import('../db/client.js');
  schema = await import('../db/schema.js');
  store = await import('../imap/store.js');
  const { apiRoutes } = await import('./api.js');
  const { issueToken } = await import('../http/auth.js');

  runMigrations();
  rawDb = client.db;

  app = Fastify();
  // Mirror the real server: JWT plugin, then the encapsulated protected API plugin.
  await app.register(jwt, { secret: process.env.JWT_SECRET as string });
  await app.register(apiRoutes);
  await app.ready();
  token = issueToken(app);
});

after(async () => {
  await app?.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

// --- request helpers (all authenticated unless noted) ---
// `token` is minted in before(); read it at call time, not at module eval.
const auth = () => ({ authorization: `Bearer ${token}` });
const get = (url: string) => app.inject({ method: 'GET', url, headers: auth() });
const send = (method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: auth(), payload: payload as object });

// --- seed helpers (each test uses a fresh account so queries can't bleed) ---
function seedAccount(): string {
  const id = randomUUID();
  rawDb
    .insert(schema.accounts)
    .values({
      id,
      email: `${id}@example.com`,
      provider: 'imap',
      imapHost: 'imap.example.com',
      smtpHost: 'smtp.example.com',
    })
    .run();
  return id;
}

function seedFolder(accountId: string, role: FolderRole): string {
  const id = randomUUID();
  rawDb
    .insert(schema.folders)
    .values({ id, accountId, path: `${role}-${id}`, name: role, role })
    .run();
  return id;
}

/** Insert a message into a folder via the real store; override only what a test cares about. */
function seedMessage(
  accountId: string,
  folderId: string,
  role: FolderRole,
  overrides: Partial<ParsedMessage> = {},
): string {
  const to: EmailAddress[] = [{ name: 'Bob', address: 'bob@example.com' }];
  const parsed: ParsedMessage = {
    messageId: `<${randomUUID()}@example.com>`,
    gmMsgId: null,
    providerThreadId: null,
    inReplyTo: null,
    references: null,
    subject: 'Subject line',
    fromName: 'Alice',
    fromAddress: 'alice@example.com',
    to,
    cc: [],
    snippet: 'a short snippet',
    bodyText: 'plain text body',
    bodyHtml: '<p>html body</p>',
    sourcePath: null,
    sentAt: new Date('2025-01-01T00:00:00Z'),
    receivedAt: new Date('2025-01-01T00:00:05Z'),
    flags: { seen: false, flagged: false, answered: false, draft: false },
    attachments: [],
    ...overrides,
  };
  return store.upsertMessage(accountId, folderId, 100, parsed, role).id;
}

test('auth gate: protected route is 401 without a token, 200 with one', async () => {
  const anon = await app.inject({ method: 'GET', url: '/api/config' });
  assert.equal(anon.statusCode, 401);

  const ok = await get('/api/config');
  assert.equal(ok.statusCode, 200);
  assert.equal(typeof ok.json().cacheWindowDays, 'number');
});

test('GET /api/accounts shapes rows via toAccountDto', async () => {
  const accountId = seedAccount();
  const res = await get('/api/accounts');
  assert.equal(res.statusCode, 200);
  const row = res.json().find((a: { id: string }) => a.id === accountId);
  assert.ok(row, 'seeded account present');
  assert.equal(row.email, `${accountId}@example.com`);
  assert.equal(row.provider, 'imap');
  assert.ok('displayName' in row);
});

test('GET /api/accounts/:id/folders lists the account folders as DTOs', async () => {
  const accountId = seedAccount();
  const inbox = seedFolder(accountId, 'inbox');
  const res = await get(`/api/accounts/${accountId}/folders`);
  assert.equal(res.statusCode, 200);
  const folder = res.json().find((f: { id: string }) => f.id === inbox);
  assert.ok(folder);
  assert.equal(folder.role, 'inbox');
  assert.equal(folder.accountId, accountId);
});

test('GET /api/folders/:folderId/messages returns message DTOs, newest first, limit honoured', async () => {
  const accountId = seedAccount();
  const folderId = seedFolder(accountId, 'inbox');
  const older = seedMessage(accountId, folderId, 'inbox', {
    subject: 'older',
    receivedAt: new Date('2025-01-01T00:00:00Z'),
  });
  const newer = seedMessage(accountId, folderId, 'inbox', {
    subject: 'newer',
    receivedAt: new Date('2025-02-01T00:00:00Z'),
  });

  const all = await get(`/api/folders/${folderId}/messages`);
  assert.equal(all.statusCode, 200);
  const ids = all.json().map((m: { id: string }) => m.id);
  assert.deepEqual(ids, [newer, older], 'newest first');
  const first = all.json()[0];
  assert.equal(first.subject, 'newer');
  assert.deepEqual(first.to, [{ name: 'Bob', address: 'bob@example.com' }]);
  assert.equal(first.seen, false);
  assert.deepEqual(first.folderIds, [folderId]);

  const limited = await get(`/api/folders/${folderId}/messages?limit=1`);
  assert.equal(limited.json().length, 1);
  assert.equal(limited.json()[0].id, newer);
});

test('GET /api/inbox merges every account inbox, newest first, excluding non-inbox mail', async () => {
  const accA = seedAccount();
  const accB = seedAccount();
  const inboxA = seedFolder(accA, 'inbox');
  const inboxB = seedFolder(accB, 'inbox');
  const sentB = seedFolder(accB, 'sent');

  const older = seedMessage(accA, inboxA, 'inbox', {
    subject: 'older inbox A',
    receivedAt: new Date('2025-03-01T00:00:00Z'),
  });
  const newer = seedMessage(accB, inboxB, 'inbox', {
    subject: 'newer inbox B',
    receivedAt: new Date('2025-04-01T00:00:00Z'),
  });
  const sent = seedMessage(accB, sentB, 'sent', {
    subject: 'sent — not an inbox',
    receivedAt: new Date('2025-05-01T00:00:00Z'),
  });

  const res = await get('/api/inbox');
  assert.equal(res.statusCode, 200);
  const ids = res.json().map((m: { id: string }) => m.id);
  assert.ok(ids.includes(newer) && ids.includes(older), 'both accounts present');
  assert.ok(!ids.includes(sent), 'non-inbox mail excluded');
  assert.ok(ids.indexOf(newer) < ids.indexOf(older), 'newest first across accounts');
});

test('GET /api/messages/:id returns the detail DTO; unknown id is 404', async () => {
  const accountId = seedAccount();
  const folderId = seedFolder(accountId, 'inbox');
  const id = seedMessage(accountId, folderId, 'inbox', {
    cc: [{ name: null, address: 'c@x.com' }],
  });

  const res = await get(`/api/messages/${id}`);
  assert.equal(res.statusCode, 200);
  const dto = res.json();
  assert.equal(dto.id, id);
  assert.equal(dto.bodyText, 'plain text body');
  assert.equal(dto.bodyHtml, '<p>html body</p>');
  assert.deepEqual(dto.cc, [{ name: null, address: 'c@x.com' }]);

  const missing = await get(`/api/messages/${randomUUID()}`);
  assert.equal(missing.statusCode, 404);
});

test('PATCH /api/messages/:id/flags updates the local row and echoes the new flags', async () => {
  const accountId = seedAccount();
  const folderId = seedFolder(accountId, 'inbox');
  const id = seedMessage(accountId, folderId, 'inbox');

  const res = await send('PATCH', `/api/messages/${id}/flags`, { seen: true });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, seen: true, flagged: false });

  // Local DB reflects the change synchronously (IMAP propagation is fire-and-forget).
  const detail = await get(`/api/messages/${id}`);
  assert.equal(detail.json().seen, true);

  const missing = await send('PATCH', `/api/messages/${randomUUID()}/flags`, { seen: true });
  assert.equal(missing.statusCode, 404);
});

test('DELETE /api/messages/:id tombstones locally so it drops out of the folder listing', async () => {
  const accountId = seedAccount();
  const folderId = seedFolder(accountId, 'inbox');
  const id = seedMessage(accountId, folderId, 'inbox');

  const res = await send('DELETE', `/api/messages/${id}`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });

  const listing = await get(`/api/folders/${folderId}/messages`);
  assert.ok(
    !listing.json().some((m: { id: string }) => m.id === id),
    'tombstoned message hidden from listing',
  );

  const missing = await send('DELETE', `/api/messages/${randomUUID()}`);
  assert.equal(missing.statusCode, 404);
});

test('POST /api/messages/:id/archive is 409 without an archive folder, 404 for unknown id', async () => {
  const accountId = seedAccount();
  const folderId = seedFolder(accountId, 'inbox');
  const id = seedMessage(accountId, folderId, 'inbox');

  const noArchive = await send('POST', `/api/messages/${id}/archive`);
  assert.equal(noArchive.statusCode, 409);
  assert.equal(noArchive.json().error, 'no archive folder');

  const missing = await send('POST', `/api/messages/${randomUUID()}/archive`);
  assert.equal(missing.statusCode, 404);
});

test('PUT /api/settings rejects a non-object body and round-trips a valid one', async () => {
  const bad = await send('PUT', '/api/settings', ['not', 'an', 'object']);
  assert.equal(bad.statusCode, 400);

  const ok = await send('PUT', '/api/settings', { theme: 'dark' });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), { ok: true });

  const read = await get('/api/settings');
  assert.equal(read.json().theme, 'dark');
});

test('GET /api/search and /api/contacts short-circuit to [] on an empty query', async () => {
  const search = await get('/api/search?q=');
  assert.equal(search.statusCode, 200);
  assert.deepEqual(search.json(), []);

  const contacts = await get('/api/contacts?q=%20');
  assert.equal(contacts.statusCode, 200);
  assert.deepEqual(contacts.json(), []);
});
