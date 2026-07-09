import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import {
  drillStateKey,
  getDrillState,
  resetCleanupReviewState,
  setDrillState,
} from '../state/cleanupDrill';

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
        excludeMessageIds: undefined,
      }),
    );
  });

  test('a saved drill review scopes the multi-select bar and the execute run', async () => {
    const { Cleanup } = await import('./Cleanup');
    const { api } = await import('../api/client');
    // A prior drill into bar.com unchecked 2 of its 7 messages (300 of its 700 bytes).
    setDrillState(drillStateKey({ slice: 'storage', domain: 'bar.com' }), {
      q: '',
      mode: 'all',
      excluded: ['m1', 'm2'],
      included: [],
      excludedBytes: 300,
      includedBytes: 0,
    });
    render(
      <MemoryRouter initialEntries={['/cleanup']}>
        <Routes>
          <Route path="/cleanup" element={<Cleanup />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Storage by sender' });
    fireEvent.click(screen.getAllByText(/Review by sender/)[0]!);
    // The row shows the review badge, and ticking the sender prices the marked subset.
    await screen.findByText('5/7 marked');
    fireEvent.click(await screen.findByRole('button', { name: /Select bar.com/ }));
    expect(screen.getByText(/1 sender · 5 msg · 400 B/)).toBeTruthy();

    fireEvent.click(await screen.findByRole('button', { name: /^Trash…$/ }));
    fireEvent.click(await screen.findByRole('button', { name: /^Move to Trash$/ }));
    await waitFor(() =>
      expect(api.cleanup.execute).toHaveBeenCalledWith({
        slice: 'storage',
        domains: ['bar.com'],
        excludeMessageIds: ['m1', 'm2'],
      }),
    );
  });

  test('a manual-mode review executes as an explicit id list', async () => {
    const { Cleanup } = await import('./Cleanup');
    const { api } = await import('../api/client');
    setDrillState(drillStateKey({ slice: 'storage', domain: 'bar.com' }), {
      q: '',
      mode: 'manual',
      excluded: [],
      included: ['m3'],
      excludedBytes: 0,
      includedBytes: 100,
    });
    render(
      <MemoryRouter initialEntries={['/cleanup']}>
        <Routes>
          <Route path="/cleanup" element={<Cleanup />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Storage by sender' });
    fireEvent.click(screen.getAllByText(/Review by sender/)[0]!);
    await screen.findByText('1/7 marked');
    fireEvent.click(await screen.findByRole('button', { name: /Select bar.com/ }));
    expect(screen.getByText(/1 sender · 1 msg · 100 B/)).toBeTruthy();

    fireEvent.click(await screen.findByRole('button', { name: /^Trash…$/ }));
    fireEvent.click(await screen.findByRole('button', { name: /^Move to Trash$/ }));
    await waitFor(() =>
      expect(api.cleanup.execute).toHaveBeenCalledWith({
        slice: 'storage',
        messageIds: ['m3'],
      }),
    );
  });

  test('the badge’s × discards the saved review', async () => {
    const { Cleanup } = await import('./Cleanup');
    const key = drillStateKey({ slice: 'storage', domain: 'bar.com' });
    setDrillState(key, {
      q: '',
      mode: 'all',
      excluded: ['m1'],
      included: [],
      excludedBytes: 100,
      includedBytes: 0,
    });
    render(
      <MemoryRouter initialEntries={['/cleanup']}>
        <Routes>
          <Route path="/cleanup" element={<Cleanup />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Storage by sender' });
    fireEvent.click(screen.getAllByText(/Review by sender/)[0]!);
    await screen.findByText('6/7 marked');
    fireEvent.click(screen.getByRole('button', { name: /Clear review for bar.com/ }));

    expect(getDrillState(key)).toBeUndefined();
    await screen.findByText('7 msg');
    expect(screen.queryByText('6/7 marked')).toBeNull();
  });
});
