import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { resetCleanupReviewState } from '../state/cleanupDrill';

const dashboard = {
  summary: {
    totalMessages: 10,
    totalBytes: 1000,
    protectedMessages: 0,
    trashedMessages: 0,
    trashedBytes: 0,
    keptMessages: 0,
  },
  queue: { pending: 0, failed: 0, done: 0 },
  storage: {
    slice: 'storage',
    groups: [{ domain: 'bar.com', messageCount: 7, bytes: 700, oldestAt: null, newestAt: null }],
    truncated: false,
    totalMessages: 7,
    totalBytes: 700,
  },
  coldStorage: {
    slice: 'cold-storage',
    groups: [],
    truncated: false,
    totalMessages: 0,
    totalBytes: 0,
  },
  large: { slice: 'large', groups: [], truncated: false, totalMessages: 0, totalBytes: 0 },
  newsletters: {
    slice: 'newsletters',
    groups: [],
    truncated: false,
    totalMessages: 5,
    totalBytes: 500,
  },
};

const newsletters = {
  slice: 'newsletters',
  groups: [{ domain: 'foo.com', messageCount: 3, bytes: 300, oldestAt: null, newestAt: null }],
  truncated: false,
  totalMessages: 5,
  totalBytes: 500,
};

vi.mock('../api/client', () => ({
  api: {
    cleanup: {
      dashboard: vi.fn(() => Promise.resolve(dashboard)),
      newsletters: vi.fn(() => Promise.resolve(newsletters)),
      storage: vi.fn(() =>
        Promise.resolve({
          slice: 'storage',
          groups: [
            { domain: 'bar.com', messageCount: 7, bytes: 700, oldestAt: null, newestAt: null },
          ],
          truncated: false,
          totalMessages: 7,
          totalBytes: 700,
        }),
      ),
      coldStorage: vi.fn(() => Promise.resolve(dashboard.coldStorage)),
      large: vi.fn(() => Promise.resolve(dashboard.large)),
      messages: vi.fn(() =>
        Promise.resolve({
          slice: 'newsletters',
          domain: 'foo.com',
          messages: [],
          total: 0,
          totalBytes: 0,
          truncated: false,
        }),
      ),
      queueStatus: vi.fn(() => Promise.resolve({ pending: 0, failed: 0, done: 0 })),
      execute: vi.fn(() => Promise.resolve({ slice: 'storage', queued: 7 })),
    },
  },
}));

const prefs = {
  cleanupSlices: {
    large: false,
    'cold-storage': false,
    newsletters: true,
  },
  cleanupColdYears: 2,
  cleanupLargeMinMb: 10,
  cleanupColdKeepKeywords: [],
  cleanupNewsletterKeywords: [],
  cleanupProtectedKeywords: [],
};
vi.mock('../state/prefs', () => ({
  usePrefs: () => prefs,
  getPrefs: () => prefs,
  setPref: vi.fn(),
}));

let lastPath = '';
function PathSpy() {
  lastPath = useLocation().pathname + useLocation().search;
  return null;
}

beforeEach(() => {
  lastPath = '';
  // The review stores are deliberately session-lived; between tests they must start clean.
  resetCleanupReviewState();
});

describe('Cleanup review-by-sender drill', () => {
  test('clicking a sender navigates to the drill-down', async () => {
    const { Cleanup } = await import('./Cleanup');
    const { CleanupMessages } = await import('./CleanupMessages');
    render(
      <MemoryRouter initialEntries={['/cleanup']}>
        <PathSpy />
        <Routes>
          <Route path="/cleanup" element={<Cleanup />} />
          <Route path="/cleanup/messages" element={<CleanupMessages />} />
        </Routes>
      </MemoryRouter>,
    );

    // Wait for the newsletters card to render.
    await screen.findByRole('heading', { name: 'Newsletters & bulk mail' });
    // Expand "Review by sender" on the newsletters card (the storage card has one too).
    fireEvent.click(screen.getAllByText(/Review by sender/)[1]!);
    // Wait for the sender row.
    const row = await screen.findByRole('button', { name: /Review messages from foo.com/ });
    fireEvent.click(row);

    await waitFor(() => expect(lastPath).toContain('/cleanup/messages'));
    expect(lastPath).toContain('slice=newsletters');
    expect(lastPath).toContain('domain=foo.com');
  });

  test('the storage audit drills by sender too', async () => {
    const { Cleanup } = await import('./Cleanup');
    const { CleanupMessages } = await import('./CleanupMessages');
    render(
      <MemoryRouter initialEntries={['/cleanup']}>
        <PathSpy />
        <Routes>
          <Route path="/cleanup" element={<Cleanup />} />
          <Route path="/cleanup/messages" element={<CleanupMessages />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Storage by sender' });
    // The storage card's "Review by sender" is the first one on the page.
    fireEvent.click(screen.getAllByText(/Review by sender/)[0]!);
    const row = await screen.findByRole('button', { name: /Review messages from bar.com/ });
    fireEvent.click(row);

    await waitFor(() => expect(lastPath).toContain('/cleanup/messages'));
    expect(lastPath).toContain('slice=storage');
    expect(lastPath).toContain('domain=bar.com');
  });

  test('storage multi-select trashes the ticked senders after a confirm', async () => {
    const { Cleanup } = await import('./Cleanup');
    const { api } = await import('../api/client');
    render(
      <MemoryRouter initialEntries={['/cleanup']}>
        <Routes>
          <Route path="/cleanup" element={<Cleanup />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Storage by sender' });
    // Open the storage card's "Review by sender" (the first on the page).
    fireEvent.click(screen.getAllByText(/Review by sender/)[0]!);
    // Tick the sender, then trash → confirm.
    const checkbox = await screen.findByRole('button', { name: /Select bar.com/ });
    fireEvent.click(checkbox);
    fireEvent.click(await screen.findByRole('button', { name: /^Trash…$/ }));
    fireEvent.click(await screen.findByRole('button', { name: /^Move to Trash$/ }));

    await waitFor(() =>
      expect(api.cleanup.execute).toHaveBeenCalledWith({
        slice: 'storage',
        domains: ['bar.com'],
      }),
    );
  });
});
