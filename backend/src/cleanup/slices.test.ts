/**
 * Cleanup slice coverage (ROADMAP Phase 6). Pins the deterministic analytics contract:
 *  - storage audit groups every sender by estimated bytes (.eml source + body + attachments),
 *  - never-replied excludes domains the user has written back to + protected mail,
 *  - cold-storage selects old, value-marker-free, non-protected mail,
 *  - the HARD safety filter keeps financial/security mail out of delete-eligible slices.
 *
 * Same bootstrap as pipeline.test.ts: point MAILY_DATA_DIR at a throwaway dir BEFORE the
 * dynamic import so the shared db/env pick it up, then run migrations (creates the FTS5
 * index + triggers the slices depend on).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before, beforeEach } from 'node:test';
import type { CleanupSliceDto } from '@maily/shared';
import type * as SchemaNS from '../db/schema.js';
import type * as DbClientNS from '../db/client.js';
import type * as SlicesNS from './slices.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'maily-cleanup-test-'));
process.env.MAILY_DATA_DIR = tmpRoot;

let db: (typeof DbClientNS)['db'];
let schema: typeof SchemaNS;
let S: typeof SlicesNS;

const YEAR = 365.25 * 24 * 60 * 60 * 1000;

before(async () => {
  const client = await import('../db/client.js');
  const { runMigrations } = await import('../db/migrate.js');
  runMigrations();
  db = client.db;
  schema = await import('../db/schema.js');
  S = await import('./slices.js');
});

after(() => rmSync(tmpRoot, { recursive: true, force: true }));

beforeEach(() => {
  db.delete(schema.attachments).run();
  db.delete(schema.messageFolders).run();
  db.delete(schema.messages).run();
  db.delete(schema.folders).run();
  db.delete(schema.accounts).run();
});

function seedAccount(): string {
  const id = randomUUID();
  db.insert(schema.accounts)
    .values({ id, email: `${id}@me.example`, provider: 'imap', imapHost: 'i', smtpHost: 's' })
    .run();
  return id;
}

function seedFolder(accountId: string, role: 'inbox' | 'sent'): string {
  const id = randomUUID();
  db.insert(schema.folders).values({ id, accountId, path: role, name: role, role }).run();
  return id;
}

function seedMessage(
  accountId: string,
  opts: {
    fromAddress: string;
    subject?: string;
    bodyText?: string;
    receivedAt?: Date;
    toAddresses?: string;
    folderId?: string;
    sourceBytes?: number;
    seen?: boolean;
    flagged?: boolean;
    cleanupKeep?: boolean;
  },
): string {
  const id = randomUUID();
  db.insert(schema.messages)
    .values({
      id,
      accountId,
      fromAddress: opts.fromAddress,
      fromName: 'Sender',
      subject: opts.subject ?? 'Hi',
      bodyText: opts.bodyText ?? 'plain body',
      toAddresses: opts.toAddresses ?? null,
      receivedAt: opts.receivedAt ?? new Date(),
      sourceBytes: opts.sourceBytes ?? null,
      seen: opts.seen ?? false,
      flagged: opts.flagged ?? false,
      cleanupKeep: opts.cleanupKeep ?? false,
    })
    .run();
  if (opts.folderId) {
    db.insert(schema.messageFolders)
      .values({ messageId: id, folderId: opts.folderId, uid: 1 })
      .run();
  }
  return id;
}

function findGroup(slice: CleanupSliceDto, domain: string) {
  return slice.groups.find((g) => g.domain === domain);
}

test('storageByDomain: groups every domain and counts attachment + body bytes', () => {
  const acct = seedAccount();
  const m = seedMessage(acct, { fromAddress: 'a@promo.example', bodyText: 'hello world' });
  db.insert(schema.attachments).values({ messageId: m, sizeBytes: 1000 }).run();

  const slice = S.storageByDomain();
  const g = findGroup(slice, 'promo.example');
  assert.ok(g, 'promo.example present in storage audit');
  assert.equal(g!.messageCount, 1);
  // body 'hello world' (11) + attachment 1000.
  assert.equal(g!.bytes, 1011);
  assert.equal(slice.totalMessages, 1);
});

test('storageByDomain: archived .eml source_bytes is authoritative (no double-count)', () => {
  const acct = seedAccount();
  const m = seedMessage(acct, {
    fromAddress: 'a@archived.example',
    bodyText: 'hello world', // already inside the .eml
    sourceBytes: 5000, // on-disk .eml — contains body AND attachments
  });
  db.insert(schema.attachments).values({ messageId: m, sizeBytes: 1000 }).run();

  const slice = S.storageByDomain();
  const g = findGroup(slice, 'archived.example');
  assert.ok(g, 'archived.example present in storage audit');
  // source_bytes 5000 alone — the body + attachment bytes are already inside the .eml,
  // so adding them would double-count.
  assert.equal(g!.bytes, 5000);
  assert.equal(slice.totalBytes, 5000);
});

test('storageByDomain: null source_bytes contributes nothing (un-archived row)', () => {
  const acct = seedAccount();
  seedMessage(acct, { fromAddress: 'a@unarchived.example', bodyText: 'hi' }); // sourceBytes omitted → null

  const slice = S.storageByDomain();
  const g = findGroup(slice, 'unarchived.example');
  assert.ok(g);
  assert.equal(g!.bytes, 2, 'just the 2-byte body — null source_bytes coalesces to 0');
});

test('neverRepliedSenders: excludes replied-to domains and protected mail', () => {
  const acct = seedAccount();
  const inbox = seedFolder(acct, 'inbox');
  const sent = seedFolder(acct, 'sent');

  // Never replied, ordinary → candidate.
  seedMessage(acct, { fromAddress: 'news@promo.example', bodyText: 'newsletter', folderId: inbox });
  // Protected (invoice) → must be excluded even though never replied.
  seedMessage(acct, {
    fromAddress: 'billing@bank.example',
    bodyText: 'your invoice',
    folderId: inbox,
  });
  // Replied to (we sent mail to work.example) → excluded.
  seedMessage(acct, {
    fromAddress: 'colleague@work.example',
    bodyText: 'meeting',
    folderId: inbox,
  });
  // The Sent message establishing the reply relationship.
  seedMessage(acct, {
    fromAddress: `${acct}@me.example`,
    bodyText: 'reply',
    folderId: sent,
    toAddresses: JSON.stringify([{ name: 'Colleague', address: 'colleague@work.example' }]),
  });

  const slice = S.neverRepliedSenders();
  assert.ok(findGroup(slice, 'promo.example'), 'unreplied ordinary sender present');
  assert.equal(findGroup(slice, 'work.example'), undefined, 'replied-to domain excluded');
  assert.equal(findGroup(slice, 'bank.example'), undefined, 'protected mail excluded');
});

test('coldStorageCandidates: old non-protected value-free mail only', () => {
  const acct = seedAccount();
  const old = new Date(Date.now() - 3 * YEAR);
  const recent = new Date();

  seedMessage(acct, { fromAddress: 'old@promo.example', bodyText: 'sale', receivedAt: old });
  seedMessage(acct, { fromAddress: 'new@promo.example', bodyText: 'sale', receivedAt: recent });
  // Old but carries a value marker (invoice) → kept, not cold (and protected).
  seedMessage(acct, {
    fromAddress: 'billing@shop.example',
    bodyText: 'invoice 42',
    receivedAt: old,
  });
  // Old + protected (password) → excluded by safety filter.
  seedMessage(acct, {
    fromAddress: 'noreply@bank.example',
    bodyText: 'password reset',
    receivedAt: old,
  });

  const slice = S.coldStorageCandidates(2);
  assert.equal(slice.totalMessages, 1, 'only the one old, value-free, unprotected message');
  assert.ok(findGroup(slice, 'promo.example'));
  assert.equal(findGroup(slice, 'shop.example'), undefined, 'value-marker mail kept');
  assert.equal(findGroup(slice, 'bank.example'), undefined, 'protected mail excluded');
});

test('largeMessages: only messages over the MB threshold, protected mail excluded', () => {
  const acct = seedAccount();
  // ~2 MB attachment → over a 1 MB threshold.
  const big = seedMessage(acct, { fromAddress: 'cam@photos.example', bodyText: 'pics' });
  db.insert(schema.attachments)
    .values({ messageId: big, sizeBytes: 2 * 1024 * 1024 })
    .run();
  // Small message → under the threshold.
  seedMessage(acct, { fromAddress: 'a@small.example', bodyText: 'tiny' });
  // Big but protected (invoice) → the HARD gate keeps it out.
  const prot = seedMessage(acct, { fromAddress: 'b@bank.example', bodyText: 'your invoice' });
  db.insert(schema.attachments)
    .values({ messageId: prot, sizeBytes: 2 * 1024 * 1024 })
    .run();

  const slice = S.largeMessages(1);
  assert.equal(slice.totalMessages, 1, 'only the big, unprotected message');
  assert.ok(findGroup(slice, 'photos.example'));
  assert.equal(findGroup(slice, 'small.example'), undefined, 'small mail excluded');
  assert.equal(findGroup(slice, 'bank.example'), undefined, 'protected mail excluded');

  // Resolves to the same message on the execute path.
  const refs = S.sliceMessageIds('large', { minMb: 1 });
  assert.deepEqual(
    refs.map((r) => r.id),
    [big],
  );
});

test('unreadOldMessages: unread + old only; seen, recent, flagged and protected excluded', () => {
  const acct = seedAccount();
  const old = new Date(Date.now() - 2 * YEAR);

  const stale = seedMessage(acct, {
    fromAddress: 'a@promo.example',
    bodyText: 'sale',
    receivedAt: old,
  });
  // Opened → excluded even though old.
  seedMessage(acct, {
    fromAddress: 'b@read.example',
    bodyText: 'sale',
    receivedAt: old,
    seen: true,
  });
  // Unread but recent → excluded.
  seedMessage(acct, { fromAddress: 'c@new.example', bodyText: 'sale' });
  // Unread + old but flagged → deliberately kept.
  seedMessage(acct, {
    fromAddress: 'd@starred.example',
    bodyText: 'sale',
    receivedAt: old,
    flagged: true,
  });
  // Unread + old but protected (password) → the HARD gate keeps it out.
  seedMessage(acct, {
    fromAddress: 'e@bank.example',
    bodyText: 'password reset',
    receivedAt: old,
  });

  const slice = S.unreadOldMessages(12);
  assert.equal(slice.totalMessages, 1, 'only the unread, old, unflagged, unprotected message');
  assert.ok(findGroup(slice, 'promo.example'));

  const refs = S.sliceMessageIds('unread', { months: 12 });
  assert.deepEqual(
    refs.map((r) => r.id),
    [stale],
  );
});

test('newsletterMessages: unsubscribe-marker mail only (EN+NO), protected excluded', () => {
  const acct = seedAccount();

  const en = seedMessage(acct, {
    fromAddress: 'news@promo.example',
    bodyText: 'Click here to unsubscribe from this list',
  });
  const no = seedMessage(acct, {
    fromAddress: 'nyhet@avis.example',
    bodyText: 'Du kan melde deg av vårt nyhetsbrev her',
  });
  // Ordinary personal mail → not a newsletter.
  seedMessage(acct, { fromAddress: 'mum@family.example', bodyText: 'see you sunday' });
  // Newsletter-marked but protected (invoice) → the HARD gate keeps it out.
  seedMessage(acct, {
    fromAddress: 'billing@shop.example',
    bodyText: 'your invoice — unsubscribe here',
  });

  const slice = S.newsletterMessages();
  assert.equal(slice.totalMessages, 2, 'both unsubscribe-marked, unprotected messages');
  assert.ok(findGroup(slice, 'promo.example'));
  assert.ok(findGroup(slice, 'avis.example'), 'Norwegian marker matches');
  assert.equal(findGroup(slice, 'family.example'), undefined, 'personal mail excluded');
  assert.equal(findGroup(slice, 'shop.example'), undefined, 'protected mail excluded');

  const ids = new Set(S.sliceMessageIds('newsletters').map((r) => r.id));
  assert.deepEqual(ids, new Set([en, no]));
});

test('sliceMessages(large): drill-down lists exactly the over-threshold messages', () => {
  const acct = seedAccount();
  const big = seedMessage(acct, { fromAddress: 'cam@photos.example', subject: 'Holiday pics' });
  db.insert(schema.attachments)
    .values({ messageId: big, sizeBytes: 3 * 1024 * 1024 })
    .run();
  seedMessage(acct, { fromAddress: 'a@photos.example', bodyText: 'tiny' });

  const res = S.sliceMessages('large', { minMb: 1, domain: 'photos.example' });
  assert.deepEqual(
    res.messages.map((m) => m.id),
    [big],
  );
  assert.equal(res.messages[0]!.subject, 'Holiday pics');
});

test('sliceMessageIds(cold-storage): resolves to the same messages, safety re-applied', () => {
  const acct = seedAccount();
  const old = new Date(Date.now() - 3 * YEAR);

  const coldId = seedMessage(acct, {
    fromAddress: 'old@promo.example',
    bodyText: 'sale',
    receivedAt: old,
  });
  // Old + protected (password) → must NOT resolve, the HARD gate re-applies at execution time.
  seedMessage(acct, {
    fromAddress: 'noreply@bank.example',
    bodyText: 'password reset',
    receivedAt: old,
  });

  const refs = S.sliceMessageIds('cold-storage', { years: 2 });
  assert.deepEqual(
    refs.map((r) => r.id),
    [coldId],
    'only the cold, unprotected message resolves',
  );
  assert.equal(refs[0]!.accountId, acct);
});

test('sliceMessageIds(never-replied): excludeDomains spares a domain', () => {
  const acct = seedAccount();
  const inbox = seedFolder(acct, 'inbox');

  const keepId = seedMessage(acct, {
    fromAddress: 'news@promo.example',
    bodyText: 'newsletter',
    folderId: inbox,
  });
  seedMessage(acct, {
    fromAddress: 'ads@spam.example',
    bodyText: 'buy now',
    folderId: inbox,
  });

  const all = S.sliceMessageIds('never-replied');
  assert.equal(all.length, 2, 'both unreplied senders resolve');

  const spared = S.sliceMessageIds('never-replied', { excludeDomains: ['spam.example'] });
  assert.deepEqual(
    spared.map((r) => r.id),
    [keepId],
    'the unchecked domain is dropped from the resolved set',
  );
});

test('sliceMessageIds(never-replied): domain scopes to one sender', () => {
  const acct = seedAccount();
  const inbox = seedFolder(acct, 'inbox');

  const keepId = seedMessage(acct, {
    fromAddress: 'news@promo.example',
    bodyText: 'newsletter',
    folderId: inbox,
  });
  seedMessage(acct, { fromAddress: 'ads@spam.example', bodyText: 'buy now', folderId: inbox });

  const scoped = S.sliceMessageIds('never-replied', { domain: 'promo.example' });
  assert.deepEqual(
    scoped.map((r) => r.id),
    [keepId],
    'only the scoped sender resolves',
  );
});

test('sliceMessageIds(never-replied): messageIds intersect the eligible set', () => {
  const acct = seedAccount();
  const inbox = seedFolder(acct, 'inbox');

  const a = seedMessage(acct, { fromAddress: 'a@promo.example', bodyText: 'hi', folderId: inbox });
  const b = seedMessage(acct, { fromAddress: 'b@promo.example', bodyText: 'hi', folderId: inbox });

  // Pick only one of the eligible messages plus a bogus id — the bogus one is dropped.
  const refs = S.sliceMessageIds('never-replied', { messageIds: [a, 'does-not-exist'] });
  assert.deepEqual(
    refs.map((r) => r.id),
    [a],
    'only the selected, eligible id resolves; the unknown id is ignored',
  );
  assert.ok(!refs.some((r) => r.id === b), 'the unselected eligible message is left alone');
});

test('cleanup_keep: a preserved message drops out of slices, previews and execute', () => {
  const acct = seedAccount();
  const old = new Date(Date.now() - 3 * YEAR);

  const cold = seedMessage(acct, {
    fromAddress: 'a@promo.example',
    bodyText: 'sale',
    receivedAt: old,
  });
  // Same slice-eligible shape, but user-preserved → excluded everywhere a delete could reach it.
  const kept = seedMessage(acct, {
    fromAddress: 'b@promo.example',
    bodyText: 'sale',
    receivedAt: old,
    cleanupKeep: true,
  });

  const slice = S.coldStorageCandidates(2);
  assert.equal(slice.totalMessages, 1, 'only the non-preserved message counts');
  assert.equal(
    findGroup(slice, 'b@promo.example'),
    undefined,
    'preserved sender absent from slice',
  );

  const listed = S.sliceMessages('cold-storage', { years: 2 });
  assert.deepEqual(
    listed.messages.map((m) => m.id),
    [cold],
    'the drill-down never lists a preserved message',
  );

  // Even an explicit selection of the preserved id resolves to nothing.
  const refs = S.sliceMessageIds('cold-storage', { years: 2, messageIds: [cold, kept] });
  assert.deepEqual(
    refs.map((r) => r.id),
    [cold],
    'preserve wins over an explicit selection, like the safety gate',
  );
});

test('sliceMessageIds: excludeMessageIds spares ids from a whole-slice run', () => {
  const acct = seedAccount();
  const old = new Date(Date.now() - 3 * YEAR);

  const a = seedMessage(acct, {
    fromAddress: 'a@promo.example',
    bodyText: 'sale',
    receivedAt: old,
  });
  const b = seedMessage(acct, {
    fromAddress: 'b@promo.example',
    bodyText: 'sale',
    receivedAt: old,
  });
  const c = seedMessage(acct, {
    fromAddress: 'c@promo.example',
    bodyText: 'sale',
    receivedAt: old,
  });

  const refs = S.sliceMessageIds('cold-storage', { years: 2, excludeMessageIds: [b] });
  assert.deepEqual(
    new Set(refs.map((r) => r.id)),
    new Set([a, c]),
    'the whole slice minus the unchecked id (the select-all-uncheck-a-few path)',
  );
});

test('sliceMessageIds(cold-storage): a protected id passed in is dropped (safety wins)', () => {
  const acct = seedAccount();
  const old = new Date(Date.now() - 3 * YEAR);

  const coldId = seedMessage(acct, {
    fromAddress: 'old@promo.example',
    bodyText: 'sale',
    receivedAt: old,
  });
  // Old + protected (password) — even if explicitly selected, the HARD gate keeps it out.
  const protId = seedMessage(acct, {
    fromAddress: 'noreply@bank.example',
    bodyText: 'password reset',
    receivedAt: old,
  });

  const refs = S.sliceMessageIds('cold-storage', { years: 2, messageIds: [coldId, protId] });
  assert.deepEqual(
    refs.map((r) => r.id),
    [coldId],
    'the protected id is intersected away — selection cannot override safety',
  );
});

test('slice group list: offset + q paginate and filter, truncated flags more pages', () => {
  const acct = seedAccount();
  // Three distinct sender domains, descending bytes so order is deterministic.
  seedMessage(acct, { fromAddress: 'a@alpha.example', bodyText: 'x'.repeat(300) });
  seedMessage(acct, { fromAddress: 'b@beta.example', bodyText: 'x'.repeat(200) });
  seedMessage(acct, { fromAddress: 'c@gamma.example', bodyText: 'x'.repeat(100) });

  // First page of one → truncated (two more remain).
  const page1 = S.storageByDomain({ limit: 1 });
  assert.equal(page1.groups.length, 1);
  assert.equal(page1.groups[0]!.domain, 'alpha.example');
  assert.equal(page1.truncated, true);
  // Headline total spans every domain regardless of the page.
  assert.equal(page1.totalMessages, 3);

  // Offset into the list.
  const page2 = S.storageByDomain({ limit: 1, offset: 1 });
  assert.equal(page2.groups[0]!.domain, 'beta.example');
  assert.equal(page2.truncated, true);

  // Substring search reaches a specific sender (case-insensitive), no more pages.
  const found = S.storageByDomain({ q: 'GAMMA' });
  assert.deepEqual(
    found.groups.map((g) => g.domain),
    ['gamma.example'],
  );
  assert.equal(found.truncated, false);
});

test('sliceMessageIds: storage slice is not delete-eligible', () => {
  assert.throws(() => S.sliceMessageIds('storage' as 'cold-storage'), /not delete-eligible/);
});

test('sliceMessages(cold-storage): lists the in-scope messages, scoped to a domain', () => {
  const acct = seedAccount();
  const old = new Date(Date.now() - 3 * YEAR);

  const promo = seedMessage(acct, {
    fromAddress: 'old@promo.example',
    subject: 'Old sale',
    bodyText: 'sale',
    receivedAt: old,
  });
  // A second cold sender — should be excluded when we scope to promo.example.
  seedMessage(acct, { fromAddress: 'old@shop.example', bodyText: 'sale', receivedAt: old });
  // Protected (password) at the same domain → the HARD gate keeps it out of the drill-down.
  seedMessage(acct, {
    fromAddress: 'noreply@promo.example',
    bodyText: 'password reset',
    receivedAt: old,
  });

  const res = S.sliceMessages('cold-storage', { years: 2, domain: 'promo.example' });
  assert.deepEqual(
    res.messages.map((m) => m.id),
    [promo],
    'only the cold, unprotected promo.example message is listed',
  );
  assert.equal(res.total, 1);
  assert.equal(res.truncated, false);
  assert.equal(res.messages[0]!.subject, 'Old sale');
});

test('sliceMessages(never-replied): drops replied-to domains like the slice/exec paths', () => {
  const acct = seedAccount();
  const inbox = seedFolder(acct, 'inbox');
  const sent = seedFolder(acct, 'sent');

  const keep = seedMessage(acct, {
    fromAddress: 'news@promo.example',
    bodyText: 'newsletter',
    folderId: inbox,
  });
  // Replied-to domain → excluded from the drill-down too.
  seedMessage(acct, { fromAddress: 'colleague@work.example', bodyText: 'hi', folderId: inbox });
  seedMessage(acct, {
    fromAddress: `${acct}@me.example`,
    bodyText: 'reply',
    folderId: sent,
    toAddresses: JSON.stringify([{ address: 'colleague@work.example' }]),
  });

  const res = S.sliceMessages('never-replied');
  const ids = new Set(res.messages.map((m) => m.id));
  assert.ok(ids.has(keep), 'the unreplied newsletter is listed');
  assert.ok(
    !res.messages.some((m) => (m.fromAddress ?? '').endsWith('@work.example')),
    'the replied-to domain is excluded',
  );
});

test('sliceMessages: limit caps the list and flags truncation', () => {
  const acct = seedAccount();
  const old = new Date(Date.now() - 3 * YEAR);
  for (let i = 0; i < 3; i++) {
    seedMessage(acct, { fromAddress: `m${i}@promo.example`, bodyText: 'sale', receivedAt: old });
  }

  const res = S.sliceMessages('cold-storage', { years: 2, domain: 'promo.example', limit: 2 });
  assert.equal(res.messages.length, 2, 'capped at the limit');
  assert.equal(res.total, 3, 'total reflects all matches');
  assert.equal(res.truncated, true);
});

test('sender key: freemail domains group per address, corporate domains per domain', () => {
  const acct = seedAccount();
  seedMessage(acct, { fromAddress: 'Alice@Gmail.com' });
  seedMessage(acct, { fromAddress: 'alice@gmail.com' });
  seedMessage(acct, { fromAddress: 'bob@gmail.com' });
  seedMessage(acct, { fromAddress: 'far@hotmail.no' }); // country variant via label match
  seedMessage(acct, { fromAddress: 'a@corp.example' });
  seedMessage(acct, { fromAddress: 'b@corp.example' });

  const slice = S.storageByDomain();
  assert.equal(findGroup(slice, 'gmail.com'), undefined, 'no aggregate gmail.com bucket');
  assert.equal(findGroup(slice, 'alice@gmail.com')!.messageCount, 2, 'case-folded per address');
  assert.equal(findGroup(slice, 'bob@gmail.com')!.messageCount, 1);
  assert.ok(findGroup(slice, 'far@hotmail.no'), 'hotmail country variant keys per address');
  assert.equal(findGroup(slice, 'corp.example')!.messageCount, 2, 'corporate stays per domain');
});

test('sender key: drill-down and execute scope to a single freemail address', () => {
  const acct = seedAccount();
  const old = new Date(Date.now() - 3 * YEAR);
  const bobs = seedMessage(acct, {
    fromAddress: 'bob@gmail.com',
    subject: 'Old chain letter',
    bodyText: 'fwd fwd',
    receivedAt: old,
  });
  seedMessage(acct, { fromAddress: 'alice@gmail.com', bodyText: 'sale', receivedAt: old });

  const listed = S.sliceMessages('cold-storage', { years: 2, domain: 'bob@gmail.com' });
  assert.deepEqual(
    listed.messages.map((m) => m.id),
    [bobs],
    'drill-down scoped to one gmail address, not all of gmail.com',
  );

  const refs = S.sliceMessageIds('cold-storage', { years: 2, domain: 'bob@gmail.com' });
  assert.deepEqual(
    refs.map((r) => r.id),
    [bobs],
    'execute scope matches the same single address',
  );
});

test('neverRepliedSenders: replying to one gmail address does not excuse the rest', () => {
  const acct = seedAccount();
  const inbox = seedFolder(acct, 'inbox');
  const sent = seedFolder(acct, 'sent');

  seedMessage(acct, { fromAddress: 'friend@gmail.com', bodyText: 'hi', folderId: inbox });
  seedMessage(acct, { fromAddress: 'noisy@gmail.com', bodyText: 'chain mail', folderId: inbox });
  seedMessage(acct, {
    fromAddress: `${acct}@me.example`,
    bodyText: 'reply',
    folderId: sent,
    toAddresses: JSON.stringify([{ address: 'Friend@gmail.com' }]),
  });

  const slice = S.neverRepliedSenders();
  assert.equal(findGroup(slice, 'friend@gmail.com'), undefined, 'replied-to address excluded');
  assert.ok(findGroup(slice, 'noisy@gmail.com'), 'other gmail senders still candidates');
});

test('sliceMessages: q filters by subject and sender (case-insensitive)', () => {
  const acct = seedAccount();
  const old = new Date(Date.now() - 3 * YEAR);
  const hit = seedMessage(acct, {
    fromAddress: 'shop@promo.example',
    subject: 'Summer SALE catalogue',
    bodyText: 'buy',
    receivedAt: old,
  });
  seedMessage(acct, {
    fromAddress: 'other@promo.example',
    subject: 'Hello',
    bodyText: 'buy',
    receivedAt: old,
  });

  const bySubject = S.sliceMessages('cold-storage', { years: 2, q: 'sale' });
  assert.deepEqual(
    bySubject.messages.map((m) => m.id),
    [hit],
  );
  assert.equal(bySubject.total, 1, 'total reflects the filtered set');

  const bySender = S.sliceMessages('cold-storage', { years: 2, q: 'SHOP@' });
  assert.deepEqual(
    bySender.messages.map((m) => m.id),
    [hit],
  );
});

test('cleanupSummary: counts protected mail', () => {
  const acct = seedAccount();
  seedMessage(acct, { fromAddress: 'a@x.example', bodyText: 'invoice attached' });
  seedMessage(acct, { fromAddress: 'b@x.example', bodyText: 'just chatting' });

  const summary = S.cleanupSummary();
  assert.equal(summary.totalMessages, 2);
  assert.equal(summary.protectedMessages, 1);
});
