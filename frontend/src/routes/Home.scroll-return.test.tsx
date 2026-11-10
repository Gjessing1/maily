import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { MessageDto } from '@maily/shared';

const rows: MessageDto[] = Array.from({ length: 130 }, (_, index) => ({
  id: `scroll-test-${index}`,
  accountId: 'acc1',
  threadId: null,
  subject: `subject ${index}`,
  fromName: null,
  fromAddress: 'a@example.com',
  to: [],
  snippet: null,
  sentAt: new Date(Date.UTC(2026, 7, 20) - index * 60_000).toISOString(),
  receivedAt: new Date(Date.UTC(2026, 7, 20) - index * 60_000).toISOString(),
  seen: true,
  flagged: false,
  localOnly: false,
  folderIds: ['inbox1'],
  attachments: [],
}));

const useMessages = vi.fn(() => ({
  messages: rows,
  loading: false,
  refreshing: false,
  hasMore: false,
  error: null,
  loadMore: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('../state/data', () => ({
  useAccounts: () => [{ id: 'acc1', email: 'a@example.com' }],
  useFolders: () => [{ id: 'inbox1', role: 'inbox', name: 'Inbox' }],
  useMessages,
}));
vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: () => ({ id: 'inbox1', role: 'inbox', name: 'Inbox' }),
}));
vi.mock('../state/prefs', () => ({
  getPrefs: () => ({ dateFormat: 'system' }),
  usePrefs: () => ({
    readingPane: 'none',
    readingPaneMinWidth: 1000,
    conversationView: false,
    unreadAtTop: false,
    swipeRight: 'read',
    swipeLeft: 'delete',
  }),
}));
vi.mock('../state/connectivity', () => ({ useOnlineStatus: () => true }));
vi.mock('../ui/useMediaQuery', () => ({ useMediaQuery: () => false }));
vi.mock('../ui/usePullToRefresh', () => ({
  usePullToRefresh: () => ({
    distance: 0,
    progress: 0,
    refreshing: false,
    dragging: false,
    handlers: {},
  }),
}));
vi.mock('../ui/PullToRefreshIndicator', () => ({ PullToRefreshIndicator: () => null }));
vi.mock('../components/FolderDrawer', () => ({ FolderDrawer: () => null }));
vi.mock('../components/ConfirmDialog', () => ({ ConfirmDialog: () => null }));
vi.mock('../state/backButton', () => ({ useBackHandler: () => undefined }));

function Reader() {
  const navigate = useNavigate();
  return <button onClick={() => navigate(-1)}>Back to inbox</button>;
}

describe('Home scroll return', () => {
  it('restores its scroll offset and loaded rows after opening a message', async () => {
    const { Home } = await import('./Home');
    const { container } = render(
      <MemoryRouter initialEntries={['/?folder=inbox1']}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/m/:id" element={<Reader />} />
        </Routes>
      </MemoryRouter>,
    );

    const list = container.querySelector('main')!;
    list.scrollTop = 600;
    fireEvent.scroll(list);
    fireEvent.click(container.querySelector('a[href="/m/scroll-test-0"]')!);
    await screen.findByRole('button', { name: 'Back to inbox' });

    fireEvent.click(screen.getByRole('button', { name: 'Back to inbox' }));
    await waitFor(() => expect(container.querySelector('main')?.scrollTop).toBe(600));
    expect(useMessages).toHaveBeenLastCalledWith('inbox1', 130);
  });
});
