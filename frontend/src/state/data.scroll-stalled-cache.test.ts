/** A fast head refresh must not collapse a restored deep list before Dexie answers. */
import 'fake-indexeddb/auto';
import { renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { MessageDto } from '@maily/shared';

localStorage.setItem('maily.prefs', JSON.stringify({ unreadAtTop: false, pageSize: 100 }));

const rows: MessageDto[] = Array.from({ length: 130 }, (_, index) => {
  const date = new Date(Date.UTC(2026, 7, 20) - index * 60_000).toISOString();
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
});

let cacheRows: MessageDto[] | undefined = rows;
vi.mock('dexie-react-hooks', () => ({ useLiveQuery: () => cacheRows }));
vi.mock('../api/client', () => ({
  api: {
    messages: vi.fn(() => Promise.resolve(rows.slice(0, 100))),
    message: vi.fn(() => Promise.reject(new Error('no body in this test'))),
  },
}));
vi.mock('../api/socket', () => ({
  onSocketReconnect: () => () => undefined,
  onSignal: () => () => undefined,
}));

it('keeps 130 rows while a remount head fetch returns only 100', async () => {
  const { useMessages } = await import('./data');
  const first = renderHook(() => useMessages('inbox1', 130));
  expect(first.result.current.messages?.length).toBe(130);
  first.unmount();

  cacheRows = undefined; // the remounted Dexie query has not answered yet
  const returned = renderHook(() => useMessages('inbox1', 130));
  expect(returned.result.current.messages?.length).toBe(130);
  await waitFor(() => expect(returned.result.current.refreshing).toBe(false));
  expect(returned.result.current.messages?.length).toBe(130);
  returned.unmount();
});
