// fake-indexeddb must load before Dexie instantiates (cache.ts runs at import).
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { MessageDto } from '@maily/shared';
import {
  cache,
  cacheBody,
  cacheMessages,
  clearRemovalTombstone,
  reconcileHeadPage,
  reconcileStarredPage,
  removeCachedMessage,
} from './cache';

function msg(id: string, receivedAt: string, over: Partial<MessageDto> = {}): MessageDto {
  return {
    id,
    accountId: 'acc1',
    threadId: null,
    subject: `subject ${id}`,
    fromName: null,
    fromAddress: 'a@example.com',
    to: [],
    snippet: null,
    sentAt: receivedAt,
    receivedAt,
    seen: false,
    flagged: false,
    localOnly: false,
    folderIds: ['inbox1'],
    attachments: [],
    ...over,
  };
}

async function cachedIds(): Promise<string[]> {
  return (await cache.messages.toArray()).map((m) => m.id).sort();
}

beforeEach(async () => {
  await cache.messages.clear();
  await cache.bodies.clear();
});

describe('reconcileHeadPage', () => {
  it('drops cached rows inside the fetched window that the server no longer returns', async () => {
    await cacheMessages([
      msg('kept', '2026-07-01T10:00:00Z'),
      msg('gone', '2026-07-01T09:00:00Z'), // archived on another device
      msg('older', '2026-06-01T09:00:00Z'), // below the window — must survive
    ]);
    const page = [msg('kept', '2026-07-01T10:00:00Z'), msg('boundary', '2026-07-01T08:00:00Z')];
    await cacheMessages(page);
    await reconcileHeadPage(['inbox1'], page, true);
    expect(await cachedIds()).toEqual(['boundary', 'kept', 'older']);
  });

  it('treats a short page as the whole folder and drops every absent row', async () => {
    await cacheMessages([
      msg('gone', '2026-07-01T09:00:00Z'),
      msg('old-gone', '2020-01-01T09:00:00Z'),
    ]);
    const page = [msg('kept', '2026-07-01T10:00:00Z')];
    await cacheMessages(page);
    await reconcileHeadPage(['inbox1'], page, false);
    expect(await cachedIds()).toEqual(['kept']);
  });

  it('spares rows whose membership the fetched view filters out (Archived subtraction)', async () => {
    await cacheMessages([
      msg('in-inbox-too', '2026-07-01T10:00:00Z', { folderIds: ['archive1', 'inbox1'] }),
      msg('gone', '2026-07-01T09:30:00Z', { folderIds: ['archive1'] }),
    ]);
    await reconcileHeadPage(['archive1'], [], false, new Set(['inbox1']));
    expect(await cachedIds()).toEqual(['in-inbox-too']);
  });

  it('does not touch rows in other folders', async () => {
    await cacheMessages([msg('other', '2026-07-01T10:00:00Z', { folderIds: ['sent1'] })]);
    await reconcileHeadPage(['inbox1'], [], false);
    expect(await cachedIds()).toEqual(['other']);
  });

  it('also drops the cached body of a reconciled-away row', async () => {
    await cacheMessages([msg('gone', '2026-07-01T09:00:00Z')]);
    await cache.bodies.put({
      ...msg('gone', '2026-07-01T09:00:00Z'),
      messageId: null,
      bodyText: 'x',
      bodyHtml: null,
      inReplyTo: null,
      references: null,
      cc: [],
      cachedAt: Date.now(),
    });
    await reconcileHeadPage(['inbox1'], [], false);
    expect(await cache.bodies.get('gone')).toBeUndefined();
  });
});

describe('reconcileStarredPage', () => {
  it('clears the flag on rows unstarred elsewhere without deleting them', async () => {
    await cacheMessages([
      msg('still-starred', '2026-07-01T10:00:00Z', { flagged: true }),
      msg('unstarred', '2026-07-01T09:00:00Z', { flagged: true }),
      msg('other-account', '2026-07-01T09:00:00Z', { flagged: true, accountId: 'acc2' }),
    ]);
    const page = [msg('still-starred', '2026-07-01T10:00:00Z', { flagged: true })];
    await reconcileStarredPage('acc1', page, false);
    expect(await cachedIds()).toEqual(['other-account', 'still-starred', 'unstarred']);
    expect((await cache.messages.get('unstarred'))?.flagged).toBe(false);
    expect((await cache.messages.get('still-starred'))?.flagged).toBe(true);
    expect((await cache.messages.get('other-account'))?.flagged).toBe(true);
  });
});

describe('removal tombstones', () => {
  it('blocks a late list/body write from resurrecting a removed message', async () => {
    const row = msg('ghost', '2026-07-01T10:00:00Z');
    await cacheMessages([row]);
    await removeCachedMessage('ghost');
    // The in-flight fetch resolves after the delete signal…
    await cacheMessages([row]);
    await cacheBody({
      ...row,
      messageId: null,
      bodyText: 'x',
      bodyHtml: null,
      inReplyTo: null,
      references: null,
      cc: [],
    });
    expect(await cachedIds()).toEqual([]);
    expect(await cache.bodies.get('ghost')).toBeUndefined();
    clearRemovalTombstone('ghost'); // don't leak into other tests
  });

  it('clearRemovalTombstone lets the message cache again (undo / mail:restored)', async () => {
    const row = msg('back', '2026-07-01T10:00:00Z');
    await removeCachedMessage('back');
    clearRemovalTombstone('back');
    await cacheMessages([row]);
    expect(await cachedIds()).toEqual(['back']);
  });
});
