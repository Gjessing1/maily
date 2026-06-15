/**
 * Conversation grouping contract: the inbox folds messages sharing a thread id into
 * one row, picks the latest as representative, aggregates unread/flag/attachment
 * state, and orders threads newest-first (with unread floated up on demand). These
 * are the pure list-shaping rules behind the conversation view.
 */
import { describe, expect, test } from 'vitest';
import type { CachedMessage } from '../db/cache';
import { groupConversations } from './threads';

function msg(over: Partial<CachedMessage> & { id: string }): CachedMessage {
  return {
    accountId: 'a1',
    threadId: null,
    subject: 's',
    fromName: null,
    fromAddress: 'x@example.com',
    to: [],
    snippet: '',
    sentAt: null,
    receivedAt: null,
    seen: true,
    flagged: false,
    folderIds: [],
    attachments: [],
    cachedAt: 0,
    ...over,
  };
}

const opts = { enabled: true, unreadAtTop: false };

describe('groupConversations', () => {
  test('folds a thread into one row with the latest message as representative', () => {
    const rows = [
      msg({ id: 'b', threadId: 't1', receivedAt: '2026-01-02T00:00:00Z', snippet: 'newer' }),
      msg({ id: 'a', threadId: 't1', receivedAt: '2026-01-01T00:00:00Z', snippet: 'older' }),
    ];
    const [c] = groupConversations(rows, opts);
    expect(c!.count).toBe(2);
    expect(c!.latest.id).toBe('b');
    expect(c!.ids).toEqual(['b', 'a']); // newest-first
  });

  test('a conversation is unread/flagged if ANY member is', () => {
    const rows = [
      msg({ id: 'b', threadId: 't1', receivedAt: '2026-01-02T00:00:00Z', seen: true }),
      msg({
        id: 'a',
        threadId: 't1',
        receivedAt: '2026-01-01T00:00:00Z',
        seen: false,
        flagged: true,
      }),
    ];
    const [c] = groupConversations(rows, opts);
    expect(c!.anyUnread).toBe(true);
    expect(c!.anyFlagged).toBe(true);
  });

  test('messages without a thread id stay separate rows', () => {
    const rows = [msg({ id: 'a' }), msg({ id: 'b' })];
    expect(groupConversations(rows, opts)).toHaveLength(2);
  });

  test('disabled grouping never merges, even on a shared thread id', () => {
    const rows = [msg({ id: 'a', threadId: 't1' }), msg({ id: 'b', threadId: 't1' })];
    expect(groupConversations(rows, { enabled: false, unreadAtTop: false })).toHaveLength(2);
  });

  test('orders threads newest-first; unread floats up when requested', () => {
    const rows = [
      msg({ id: 'old-unread', threadId: 't1', receivedAt: '2026-01-01T00:00:00Z', seen: false }),
      msg({ id: 'new-read', threadId: 't2', receivedAt: '2026-01-03T00:00:00Z', seen: true }),
    ];
    expect(
      groupConversations(rows, { enabled: true, unreadAtTop: false }).map((c) => c.latest.id),
    ).toEqual(['new-read', 'old-unread']);
    expect(
      groupConversations(rows, { enabled: true, unreadAtTop: true }).map((c) => c.latest.id),
    ).toEqual(['old-unread', 'new-read']);
  });
});
