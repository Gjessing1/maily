/**
 * previewDetach partitioning: candidates split into "safe" (local `.eml` on disk) vs
 * "unsafe" (no local source — must never be deleted from the provider), honouring the
 * cutoff scope and excluding already-detached / tombstoned rows. Pure DB + filesystem
 * (no IMAP), so we point MAILY_DATA_DIR at a throwaway dir, migrate, then seed.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import type * as JobNS from './job.js';
import type * as SchemaNS from '../db/schema.js';
import type * as DbClientNS from '../db/client.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'maily-detach-test-'));
process.env.MAILY_DATA_DIR = tmpRoot;

let job: typeof JobNS;
let schema: typeof SchemaNS;
let rawDb: (typeof DbClientNS)['db'];

before(async () => {
  const client = await import('../db/client.js');
  const { runMigrations } = await import('../db/migrate.js');
  runMigrations();
  rawDb = client.db;
  schema = await import('../db/schema.js');
  job = await import('./job.js');
});

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function seedAccount(): string {
  const accountId = randomUUID();
  rawDb
    .insert(schema.accounts)
    .values({
      id: accountId,
      email: `${accountId}@example.com`,
      provider: 'imap',
      imapHost: 'imap.example.com',
      smtpHost: 'smtp.example.com',
    })
    .run();
  return accountId;
}

/** Insert a message; when `withFile` write a real `.eml` so the safe-check passes. */
function seedMessage(
  accountId: string,
  opts: { withFile?: boolean; localOnly?: boolean; deleted?: boolean; receivedAt?: Date },
): string {
  const id = randomUUID();
  let sourcePath: string | null = null;
  if (opts.withFile) {
    sourcePath = join(tmpRoot, `${id}.eml`);
    writeFileSync(sourcePath, 'From: x\r\n\r\nbody');
  }
  rawDb
    .insert(schema.messages)
    .values({
      id,
      accountId,
      subject: opts.withFile ? 'has-source' : 'no-source',
      sourcePath,
      sourceBytes: opts.withFile ? 100 : null,
      receivedAt: opts.receivedAt ?? new Date('2025-01-01T00:00:00Z'),
      localOnly: opts.localOnly ?? false,
      deletedAt: opts.deleted ? new Date() : null,
    })
    .run();
  return id;
}

test('previewDetach splits safe (local source present) from unsafe (no source)', () => {
  const accountId = seedAccount();
  seedMessage(accountId, { withFile: true });
  seedMessage(accountId, { withFile: true });
  seedMessage(accountId, { withFile: false }); // unsafe — no local copy

  const p = job.previewDetach({ accountId, scope: 'all' });
  assert.equal(p.total, 3);
  assert.equal(p.safe, 2);
  assert.equal(p.unsafe, 1);
  assert.equal(p.estimatedBytes, 200);
});

test('previewDetach excludes already-detached and tombstoned rows', () => {
  const accountId = seedAccount();
  seedMessage(accountId, { withFile: true });
  seedMessage(accountId, { withFile: true, localOnly: true }); // already detached
  seedMessage(accountId, { withFile: true, deleted: true }); // tombstoned

  const p = job.previewDetach({ accountId, scope: 'all' });
  assert.equal(p.total, 1);
  assert.equal(p.safe, 1);
});

test('cutoff scope only counts mail received before the cutoff', () => {
  const accountId = seedAccount();
  seedMessage(accountId, { withFile: true, receivedAt: new Date('2020-01-01T00:00:00Z') }); // old
  seedMessage(accountId, { withFile: true, receivedAt: new Date('2026-01-01T00:00:00Z') }); // new

  const p = job.previewDetach({
    accountId,
    scope: 'cutoff',
    cutoffMs: new Date('2023-01-01T00:00:00Z').getTime(),
  });
  assert.equal(p.total, 1);
  assert.equal(p.safe, 1);
});
