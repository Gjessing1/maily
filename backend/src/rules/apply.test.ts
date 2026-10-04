/**
 * Rules against a real (throwaway) DB: the ingest path's arrival cut-off, each move going
 * through its outbox intent (spam is a junk move, not a trash), sender-over-domain precedence,
 * hit counting, the flag STORE still aimed at the inbox copy a pending move hasn't moved yet,
 * validation, and the bounded preview / apply-to-existing.
 *
 * Same bootstrap as outbox/runner.test.ts: point MAILY_DATA_DIR before the dynamic import.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import test, { after, before, beforeEach } from 'node:test';
import type { MailRuleInput } from '@maily/shared';
import type * as SchemaNS from '../db/schema.js';
import type * as DbClientNS from '../db/client.js';
import type * as ApplyNS from './apply.js';
import type * as StoreNS from './store.js';
import type * as RunnerNS from '../outbox/runner.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'maily-rules-test-'));
process.env.MAILY_DATA_DIR = tmpRoot;

let db: (typeof DbClientNS)['db'];
let schema: typeof SchemaNS;
let A: typeof ApplyNS;
let S: typeof StoreNS;
let R: typeof RunnerNS;

before(async () => {
  const client = await import('../db/client.js');
  const { runMigrations } = await import('../db/migrate.js');
  runMigrations();
  db = client.db;
  schema = await import('../db/schema.js');
  A = await import('./apply.js');
  S = await import('./store.js');
  R = await import('../outbox/runner.js');
});

after(() => rmSync(tmpRoot, { recursive: true, force: true }));

beforeEach(() => {
  db.delete(schema.mailRules).run();
  db.delete(schema.outbox).run();
  db.delete(schema.messageFolders).run();
  db.delete(schema.messages).run();
  db.delete(schema.folders).run();
  db.delete(schema.accounts).run();
});

interface Seeded {
  accountId: string;
  inbox: string;
  junk: string;
  archive: string;
  trash: string;
}

function seedAccount(): Seeded {
  const accountId = randomUUID();
  db.insert(schema.accounts)
    .values({
      id: accountId,
      email: 'me@me.example',
      provider: 'imap',
      imapHost: 'i',
      smtpHost: 's',
    })
    .run();
  const folder = (role: 'inbox' | 'junk' | 'archive' | 'trash', path: string) => {
    const id = randomUUID();
    db.insert(schema.folders).values({ id, accountId, path, name: path, role }).run();
    return id;
  };
  return {
    accountId,
    inbox: folder('inbox', 'INBOX'),
    junk: folder('junk', 'Spam'),
    archive: folder('archive', 'Archive'),
    trash: folder('trash', 'Trash'),
  };
}

let nextUid = 1;
function seedInboxMessage(
  s: Seeded,
  from: string,
  opts: { receivedAt?: Date; seen?: boolean } = {},
): string {
  const id = randomUUID();
  db.insert(schema.messages)
    .values({
      id,
      accountId: s.accountId,
      fromAddress: from,
      subject: `from ${from}`,
      receivedAt: opts.receivedAt ?? new Date(),
      seen: opts.seen ?? false,
    })
    .run();
  db.insert(schema.messageFolders)
    .values({ messageId: id, folderId: s.inbox, uid: nextUid++ })
    .run();
  return id;
}

function addRule(input: MailRuleInput, createdAt?: Date) {
  const rule = S.createRule(S.validateRuleInput(input));
  if (createdAt) {
    db.update(schema.mailRules).set({ createdAt }).where(eq(schema.mailRules.id, rule.id)).run();
  }
  return rule;
}

function folderIds(messageId: string): string[] {
  return db
    .select({ f: schema.messageFolders.folderId })
    .from(schema.messageFolders)
    .where(eq(schema.messageFolders.messageId, messageId))
    .all()
    .map((r) => r.f);
}

function outboxKinds(messageId: string): string[] {
  return db
    .select({ kind: schema.outbox.kind })
    .from(schema.outbox)
    .where(eq(schema.outbox.messageId, messageId))
    .all()
    .map((r) => r.kind);
}

function message(id: string) {
  return db.select().from(schema.messages).where(eq(schema.messages.id, id)).get()!;
}

test('ingest: mail that arrived before the rule was created is left alone', () => {
  const s = seedAccount();
  addRule({ matchKind: 'sender', matchValue: 'spam@x.example', move: 'spam' });
  const old = seedInboxMessage(s, 'spam@x.example', { receivedAt: new Date(Date.now() - 60_000) });

  assert.equal(A.applyRulesOnIngest(s.accountId, old, s.inbox), null);
  assert.deepEqual(folderIds(old), [s.inbox]);
  assert.deepEqual(outboxKinds(old), []);
});

test('ingest: a block (spam) rule moves the inbox copy to Spam, not Trash, via a move intent', () => {
  const s = seedAccount();
  const rule = addRule({ matchKind: 'domain', matchValue: 'x.example', move: 'spam' }, new Date(0));
  const id = seedInboxMessage(s, 'promo@mail.x.example');

  assert.deepEqual(A.applyRulesOnIngest(s.accountId, id, s.inbox), { moved: true, read: false });
  assert.deepEqual(folderIds(id), [s.junk]);
  assert.equal(message(id).deletedAt, null, 'not tombstoned — spam is not trash');
  assert.deepEqual(outboxKinds(id), ['move']);
  const r = S.getRule(rule.id)!;
  assert.equal(r.hits, 1);
  assert.ok(r.lastHitAt);
});

test('ingest: sender rule move wins over domain rule move; flags are OR-ed and queued first', () => {
  const s = seedAccount();
  const domain = addRule(
    { matchKind: 'domain', matchValue: 'shop.example', move: 'spam', markRead: true },
    new Date(0),
  );
  const sender = addRule(
    { matchKind: 'sender', matchValue: 'receipts@shop.example', move: 'archive' },
    new Date(0),
  );
  const id = seedInboxMessage(s, 'Receipts@Shop.Example');

  assert.deepEqual(A.applyRulesOnIngest(s.accountId, id, s.inbox), { moved: true, read: true });
  assert.deepEqual(folderIds(id), [s.archive], 'archived, not spammed');
  assert.equal(message(id).seen, true);
  assert.deepEqual(outboxKinds(id).sort(), ['archive', 'flags']);
  assert.equal(S.getRule(domain.id)!.hits, 1, 'every matching rule counts a hit');
  assert.equal(S.getRule(sender.id)!.hits, 1);

  // The STORE must target the inbox copy the pending archive hasn't moved off the server yet.
  const loc = R.flagPlacement(id);
  assert.equal(loc.kind, 'server');
  assert.equal(loc.kind === 'server' && loc.folderPath, 'INBOX');
});

test('ingest: trash tombstones; star-only stays in the inbox and is not "handled"', () => {
  const s = seedAccount();
  addRule({ matchKind: 'sender', matchValue: 'gone@x.example', move: 'trash' }, new Date(0));
  addRule({ matchKind: 'sender', matchValue: 'vip@x.example', star: true }, new Date(0));
  const gone = seedInboxMessage(s, 'gone@x.example');
  const vip = seedInboxMessage(s, 'vip@x.example');

  assert.deepEqual(A.applyRulesOnIngest(s.accountId, gone, s.inbox), { moved: true, read: false });
  assert.notEqual(message(gone).deletedAt, null);
  assert.deepEqual(outboxKinds(gone), ['delete']);

  assert.deepEqual(A.applyRulesOnIngest(s.accountId, vip, s.inbox), { moved: false, read: false });
  assert.equal(message(vip).flagged, true);
  assert.deepEqual(folderIds(vip), [s.inbox]);
});

test('ingest: disabled rules and other accounts rules do nothing', () => {
  const s = seedAccount();
  const other = seedAccount();
  const disabled = addRule(
    { matchKind: 'sender', matchValue: 'a@x.example', move: 'spam' },
    new Date(0),
  );
  S.setRuleEnabled(disabled.id, false);
  addRule(
    { matchKind: 'domain', matchValue: 'x.example', markRead: true, accountId: other.accountId },
    new Date(0),
  );
  const id = seedInboxMessage(s, 'a@x.example');
  assert.equal(A.applyRulesOnIngest(s.accountId, id, s.inbox), null);
});

test('validation: no action, bad domain, unknown account and duplicates are refused', () => {
  const bad = (input: unknown, status = 400) =>
    assert.throws(
      () => S.createRule(S.validateRuleInput(input)),
      (err: unknown) => err instanceof S.RuleInputError && err.status === status,
    );
  bad({ matchKind: 'sender', matchValue: 'a@x.example' });
  bad({ matchKind: 'domain', matchValue: 'not a domain', move: 'spam' });
  bad({ matchKind: 'domain', matchValue: 'x.example', move: 'delete' });
  bad({ matchKind: 'sender', matchValue: 'a@x.example', star: true, accountId: 'nope' });

  addRule({ matchKind: 'domain', matchValue: 'x.example', move: 'spam' });
  bad({ matchKind: 'domain', matchValue: '@X.example', markRead: true }, 409);
});

test('preview counts only inbox mail the rule would change; apply is bounded and converges', () => {
  const s = seedAccount();
  for (let i = 0; i < A.APPLY_BATCH + 3; i++) seedInboxMessage(s, `n${i}@news.example`);
  seedInboxMessage(s, 'n@news.example', { seen: true });
  const elsewhere = seedInboxMessage(s, 'a@other.example');

  const readOnly = { matchKind: 'domain', matchValue: 'news.example', markRead: true } as const;
  const p = A.previewRule({ ...S.validateRuleInput(readOnly) });
  assert.equal(p.count, A.APPLY_BATCH + 3, 'the already-read one would not change');
  assert.equal(p.sample.length, 5);

  const rule = addRule(readOnly);
  const first = A.applyRuleToExisting(rule.id)!;
  assert.deepEqual(first, { applied: A.APPLY_BATCH, remaining: 3 });
  const second = A.applyRuleToExisting(rule.id)!;
  assert.deepEqual(second, { applied: 3, remaining: 0 });
  assert.equal(A.previewRule(S.validateRuleInput(readOnly)).count, 0);
  assert.equal(message(elsewhere).seen, false);
  assert.equal(S.getRule(rule.id)!.hits, A.APPLY_BATCH + 3);

  S.setRuleEnabled(rule.id, false);
  assert.equal(A.applyRuleToExisting(rule.id), null);
  assert.equal(A.applyRuleToExisting(randomUUID()), undefined);
});

test('apply to existing keeps sender-over-domain precedence', () => {
  const s = seedAccount();
  const domain = addRule({ matchKind: 'domain', matchValue: 'shop.example', move: 'spam' });
  addRule({ matchKind: 'sender', matchValue: 'receipts@shop.example', move: 'archive' });
  const receipt = seedInboxMessage(s, 'receipts@shop.example');
  const promo = seedInboxMessage(s, 'promo@shop.example');

  assert.deepEqual(A.applyRuleToExisting(domain.id), { applied: 2, remaining: 0 });
  assert.deepEqual(folderIds(receipt), [s.archive]);
  assert.deepEqual(folderIds(promo), [s.junk]);
  assert.equal(
    db
      .select()
      .from(schema.messageFolders)
      .where(and(eq(schema.messageFolders.folderId, s.inbox)))
      .all().length,
    0,
  );
});

test('protect-only rules never act on ingest; preview reports the shielded mail instead', () => {
  const s = seedAccount();
  const rule = addRule(
    { matchKind: 'domain', matchValue: 'bank.example', protect: true },
    new Date(0),
  );
  const id = seedInboxMessage(s, 'statements@bank.example');

  assert.equal(A.applyRulesOnIngest(s.accountId, id, s.inbox), null);
  assert.deepEqual(outboxKinds(id), []);
  assert.equal(S.getRule(rule.id)!.hits, 0, 'a gate counts no ingest hits');

  const p = A.previewRule(
    S.validateRuleInput({ matchKind: 'domain', matchValue: 'bank.example', protect: true }),
  );
  assert.equal(p.count, 0, 'nothing in the inbox to change');
  assert.equal(p.protectedCount, 1);
  assert.deepEqual(A.applyRuleToExisting(rule.id), { applied: 0, remaining: 0 });

  // Combined with an ingest action, the action still fires.
  const both = addRule(
    { matchKind: 'sender', matchValue: 'vip@x.example', star: true, protect: true },
    new Date(0),
  );
  const vip = seedInboxMessage(s, 'vip@x.example');
  assert.deepEqual(A.applyRulesOnIngest(s.accountId, vip, s.inbox), { moved: false, read: false });
  assert.equal(message(vip).flagged, true);
  assert.equal(S.getRule(both.id)!.hits, 1);
});

test('validation: protect is a boolean and cannot be combined with a Trash move', () => {
  const bad = (input: unknown) =>
    assert.throws(
      () => S.validateRuleInput(input),
      (err: unknown) => err instanceof S.RuleInputError && err.status === 400,
    );
  bad({ matchKind: 'sender', matchValue: 'a@x.example', protect: 'yes' });
  bad({ matchKind: 'sender', matchValue: 'a@x.example', protect: true, move: 'trash' });
  assert.equal(
    S.validateRuleInput({ matchKind: 'sender', matchValue: 'a@x.example', protect: true }).protect,
    true,
  );
});
