/**
 * The prepared first pages are only safe because EVERY mail mutation invalidates them.
 * A folder synced by the non-INBOX cron (Drafts, Sent, mail filtered past IDLE) emits
 * no per-message signal — it announces itself with `mail:folder` — so a first page that
 * was cached while the folder was empty must not survive it. This is the regression the
 * "All drafts shows nothing after saving a draft" report came down to.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { MessageDto } from '@maily/shared';
import { emitSignal } from '../events.js';
import { cachedFirstPage } from './listCache.js';

const row = (id: string): MessageDto => ({
  id,
  accountId: 'acc1',
  threadId: null,
  subject: id,
  fromName: null,
  fromAddress: 'a@example.com',
  to: [],
  snippet: null,
  sentAt: null,
  receivedAt: '2026-08-19T10:00:00.000Z',
  seen: true,
  flagged: false,
  localOnly: false,
  folderIds: ['drafts1'],
  attachments: [],
});

test('a repeat first-page request is served from memory, not recomputed', () => {
  const key = 'unified|drafts|100|0';
  let computes = 0;
  const compute = () => {
    computes += 1;
    return [row('m1')];
  };

  assert.deepEqual(cachedFirstPage(key, compute), [row('m1')]);
  assert.deepEqual(cachedFirstPage(key, compute), [row('m1')]);
  assert.equal(computes, 1);
});

test('mail:folder invalidates the cached page (non-INBOX cron insert)', () => {
  const key = 'unified|drafts|100|1';
  // Page one computed while the Drafts folders were still empty.
  assert.deepEqual(
    cachedFirstPage(key, () => []),
    [],
  );

  emitSignal({ type: 'mail:folder', accountId: 'acc1', folderId: 'drafts1' });

  // The draft has since synced — the next request must see it, not the cached [].
  assert.deepEqual(
    cachedFirstPage(key, () => [row('draft1')]),
    [row('draft1')],
  );
});

test('sync:progress does not invalidate — progress ticks are not list mutations', () => {
  const key = 'unified|drafts|100|2';
  assert.deepEqual(
    cachedFirstPage(key, () => [row('m1')]),
    [row('m1')],
  );

  emitSignal({ type: 'sync:progress', accountId: 'acc1', done: 1, total: 2 });

  let computed = false;
  const compute = () => {
    computed = true;
    return [row('m2')];
  };
  assert.deepEqual(cachedFirstPage(key, compute), [row('m1')]);
  assert.equal(computed, false);
});
