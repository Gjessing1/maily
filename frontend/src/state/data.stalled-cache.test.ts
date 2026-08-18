/**
 * The list must never be held hostage by IndexedDB. ARCHITECTURE §1/§6 make the backend
 * the source of truth and the Dexie cache a disposable accelerator, so when the cache
 * read does not answer — evicted, upgrading, or (the reported "loading forever") queued
 * behind the writes a head refresh just made — the fetched page paints instead.
 * `useLiveQuery` is stubbed to never emit, which is that state exactly.
 */
import 'fake-indexeddb/auto';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MessageDto } from '@maily/shared';

localStorage.setItem('maily.prefs', JSON.stringify({ unreadAtTop: false }));

function msg(id: string, receivedAt: string): MessageDto {
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
    seen: true,
    flagged: false,
    localOnly: false,
    folderIds: ['inbox1'],
    attachments: [],
  };
}

const page = [msg('m1', '2026-08-18T10:00:00.000Z'), msg('m2', '2026-08-18T09:00:00.000Z')];

vi.mock('dexie-react-hooks', () => ({ useLiveQuery: () => undefined }));

vi.mock('../api/client', () => ({
  api: {
    messages: vi.fn(() => Promise.resolve(page)),
    message: vi.fn(() => Promise.reject(new Error('no body in this test'))),
  },
}));

vi.mock('../api/socket', () => ({ onSocketReconnect: () => () => undefined }));

describe('useMessages with a cache that never answers', () => {
  it('renders the fetched page instead of spinning forever', async () => {
    const { useMessages } = await import('./data');
    const { result, unmount } = renderHook(() => useMessages('inbox1'));

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.messages?.map((m) => m.id)).toEqual(['m1', 'm2']));
    expect(result.current.loading).toBe(false);
    unmount();
  });
});
