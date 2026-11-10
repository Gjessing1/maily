/** Returning to a deep inbox position must render enough cached rows to reach it. */
import 'fake-indexeddb/auto';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageDto } from '@maily/shared';

localStorage.setItem('maily.prefs', JSON.stringify({ unreadAtTop: false, pageSize: 100 }));

vi.mock('../api/client', () => ({
  api: {
    messages: vi.fn(() => new Promise<MessageDto[]>(() => undefined)),
    message: vi.fn(() => Promise.reject(new Error('no body in this test'))),
  },
}));

vi.mock('../api/socket', () => ({
  onSocketReconnect: () => () => undefined,
  onSignal: () => () => undefined,
}));

function message(index: number): MessageDto {
  const date = new Date(Date.UTC(2026, 7, 20, 0, 0, 0) - index * 60_000).toISOString();
  return {
    id: `m${index}`,
    accountId: 'acc1',
    threadId: null,
    subject: `subject ${index}`,
    fromName: null,
    fromAddress: 'a@example.com',
    to: [],
    snippet: null,
    sentAt: date,
    receivedAt: date,
    seen: true,
    flagged: false,
    localOnly: false,
    folderIds: ['inbox1'],
    attachments: [],
  };
}

describe('useMessages return to a scrolled list', () => {
  beforeEach(async () => {
    const { cache, cacheMessages } = await import('../db/cache');
    await cache.messages.clear();
    await cacheMessages(Array.from({ length: 130 }, (_, i) => message(i)));
  });

  it('restores the loaded window on remount instead of cutting it back to page one', async () => {
    const { useMessages } = await import('./data');
    const first = renderHook(() => useMessages('inbox1', 130));
    await waitFor(() => expect(first.result.current.messages?.length).toBe(130));
    first.unmount();

    const returned = renderHook(() => useMessages('inbox1', 130));
    expect(returned.result.current.messages?.length).toBe(130);
    await waitFor(() => expect(returned.result.current.messages?.length).toBe(130));
    returned.unmount();
  });
});
