import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { describe, expect, test, vi, beforeEach } from 'vitest';

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
  neverReplied: {
    slice: 'never-replied',
    groups: [],
    truncated: false,
    totalMessages: 5,
    totalBytes: 500,
  },
  coldStorage: {
    slice: 'cold-storage',
    groups: [],
    truncated: false,
    totalMessages: 0,
    totalBytes: 0,
  },
  large: { slice: 'large', groups: [], truncated: false, totalMessages: 0, totalBytes: 0 },
  unread: { slice: 'unread', groups: [], truncated: false, totalMessages: 0, totalBytes: 0 },
  newsletters: {
    slice: 'newsletters',
    groups: [],
    truncated: false,
    totalMessages: 0,
    totalBytes: 0,
  },
};

const neverReplied = {
  slice: 'never-replied',
  groups: [{ domain: 'foo.com', messageCount: 3, bytes: 300, oldestAt: null, newestAt: null }],
  truncated: false,
  totalMessages: 5,
  totalBytes: 500,
};

vi.mock('../api/client', () => ({
  api: {
    cleanup: {
      dashboard: vi.fn(() => Promise.resolve(dashboard)),
      neverReplied: vi.fn(() => Promise.resolve(neverReplied)),
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
      unread: vi.fn(() => Promise.resolve(dashboard.unread)),
      newsletters: vi.fn(() => Promise.resolve(dashboard.newsletters)),
      messages: vi.fn(() =>
        Promise.resolve({
          slice: 'never-replied',
          domain: 'foo.com',
          messages: [],
          total: 0,
          totalBytes: 0,
          truncated: false,
        }),
      ),
      queueStatus: vi.fn(() => Promise.resolve({ pending: 0, failed: 0, done: 0 })),
    },
  },
}));

const prefs = {
  cleanupSlices: {
    large: false,
    'cold-storage': false,
    unread: false,
    newsletters: false,
    'never-replied': true,
  },
  cleanupColdYears: 2,
  cleanupLargeMinMb: 10,
  cleanupUnreadMonths: 12,
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

    // Wait for the never-replied card to render.
    await screen.findByRole('heading', { name: 'Never replied to' });
    // Expand "Review by sender" on the never-replied card (the storage card has one too).
    fireEvent.click(screen.getAllByText(/Review by sender/)[1]!);
    // Wait for the sender row.
    const row = await screen.findByRole('button', { name: /Review messages from foo.com/ });
    fireEvent.click(row);

    await waitFor(() => expect(lastPath).toContain('/cleanup/messages'));
    expect(lastPath).toContain('slice=never-replied');
    expect(lastPath).toContain('domain=foo.com');
  });

  test('the informational storage audit drills by sender too (read-only)', async () => {
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
});
