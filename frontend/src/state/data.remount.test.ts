/**
 * Returning from a message must not drop the list back to a spinner (ROADMAP priority
 * fix). `useLiveQuery` keeps its result across a folder switch but not across a remount,
 * and the reader is its own route — so the inbox re-mounted with nothing to show and sat
 * on a spinner for as long as IndexedDB took to answer, which on a phone could be
 * minutes ("loading forever"). `useMessages` now keeps the rows each view last rendered.
 */
// fake-indexeddb must load before Dexie instantiates (cache.ts runs at import).
import 'fake-indexeddb/auto';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageDto } from '@maily/shared';

// Single-fetch behaviour: "unread at top" would add a second (unread) request whose
// merge is covered by its own path; this test is about the paint fallback.
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

vi.mock('../api/client', () => ({
  api: {
    messages: vi.fn(() => Promise.resolve(page)),
    // Body prefetch — irrelevant here, and a rejection is swallowed by the hook.
    message: vi.fn(() => Promise.reject(new Error('no body in this test'))),
  },
}));

vi.mock('../api/socket', () => ({ onSocketReconnect: () => () => undefined }));

describe('useMessages across a remount', () => {
  beforeEach(async () => {
    const { cache } = await import('../db/cache');
    await cache.messages.clear();
    await cache.bodies.clear();
  });

  it('paints the rows it last showed instead of a spinner', async () => {
    const { useMessages } = await import('./data');

    const first = renderHook(() => useMessages('inbox1'));
    // Cold: nothing cached, nothing fetched yet.
    expect(first.result.current.loading).toBe(true);
    await waitFor(() => expect(first.result.current.messages?.length).toBe(2));
    first.unmount(); // ← opening a message unmounts the list

    // Back on the list: rows are there on the FIRST render, before IndexedDB (or the
    // network) has had a chance to answer this mount at all.
    const second = renderHook(() => useMessages('inbox1'));
    expect(second.result.current.loading).toBe(false);
    expect(second.result.current.messages?.map((m) => m.id)).toEqual(['m1', 'm2']);
    second.unmount();
  });

  it('still shows a spinner for a view it has never rendered', async () => {
    const { useMessages } = await import('./data');
    const { result, unmount } = renderHook(() => useMessages('someOtherFolder'));
    expect(result.current.loading).toBe(true);
    unmount();
  });
});
