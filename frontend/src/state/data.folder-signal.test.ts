/**
 * Mail that lands outside the INBOX (a saved draft, a Sent copy, mail a server-side
 * filter routed past IDLE) syncs on the folder cron, which has no per-message signal to
 * emit — Web Push stays INBOX-only (§9). It announces the pass with `mail:folder`, and
 * a mounted list must refetch its head on that: without it, "All drafts" kept painting
 * the empty page it had fetched before the draft synced.
 */
import 'fake-indexeddb/auto';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MessageDto, SocketSignal } from '@maily/shared';

localStorage.setItem('maily.prefs', JSON.stringify({ unreadAtTop: false }));

function msg(id: string): MessageDto {
  return {
    id,
    accountId: 'acc1',
    threadId: null,
    subject: `subject ${id}`,
    fromName: null,
    fromAddress: 'a@example.com',
    to: [],
    snippet: null,
    sentAt: '2026-08-19T10:00:00.000Z',
    receivedAt: '2026-08-19T10:00:00.000Z',
    seen: true,
    flagged: false,
    localOnly: false,
    folderIds: ['unified:drafts'],
    attachments: [],
  };
}

// First fetch answers empty (the draft has not synced yet); every later fetch has it.
let pages: MessageDto[][] = [];
const unified = vi.fn(() => Promise.resolve(pages.shift() ?? [msg('draft1')]));

vi.mock('dexie-react-hooks', () => ({ useLiveQuery: () => undefined }));

vi.mock('../api/client', () => ({
  api: {
    unified,
    message: vi.fn(() => Promise.reject(new Error('no body in this test'))),
  },
}));

const listeners = new Set<(s: SocketSignal) => void>();
vi.mock('../api/socket', () => ({
  onSocketReconnect: () => () => undefined,
  onSignal: (l: (s: SocketSignal) => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  },
}));

const emit = (signal: SocketSignal) => listeners.forEach((l) => l(signal));

describe('useMessages on a mail:folder signal', () => {
  it('refetches the head so a freshly synced draft appears', async () => {
    pages = [[]];
    const { useMessages } = await import('./data');
    const { result, unmount } = renderHook(() => useMessages('unified:drafts'));

    await waitFor(() => expect(result.current.messages).toEqual([]));
    expect(unified).toHaveBeenCalledTimes(1);

    // The draft's APPEND triggered a folder reconcile; the cron reports the insert.
    await act(async () => {
      emit({ type: 'mail:folder', accountId: 'acc1', folderId: 'drafts1' });
    });

    await waitFor(() => expect(result.current.messages?.map((m) => m.id)).toEqual(['draft1']));
    unmount();
  });

  it('ignores signals that carry their own per-message handling', async () => {
    pages = [[msg('draft1')]];
    unified.mockClear();
    const { useMessages } = await import('./data');
    const { result, unmount } = renderHook(() => useMessages('unified:drafts'));

    await waitFor(() => expect(result.current.messages?.map((m) => m.id)).toEqual(['draft1']));
    expect(unified).toHaveBeenCalledTimes(1);

    await act(async () => {
      emit({ type: 'sync:progress', accountId: 'acc1', done: 1, total: 2 });
    });
    expect(unified).toHaveBeenCalledTimes(1);
    unmount();
  });
});
