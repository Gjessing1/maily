/**
 * The drill-down preserves an in-progress selection across navigation (ROADMAP Phase 6b
 * workflow fix). Tapping a message open in the reader unmounts this screen; without the
 * module-level drill-state cache, returning would reset every checkbox to the all-selected
 * default and lose the review in progress. Here we deselect a row, unmount, remount the same
 * drill, and assert the deselection survived.
 */
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { describe, expect, test, vi, beforeEach } from 'vitest';

const messages = [
  {
    id: 'm1',
    subject: 'First',
    fromName: 'A',
    fromAddress: 'a@foo.com',
    receivedAt: null,
    bytes: 10,
  },
  {
    id: 'm2',
    subject: 'Second',
    fromName: 'B',
    fromAddress: 'b@foo.com',
    receivedAt: null,
    bytes: 20,
  },
];

vi.mock('../api/client', () => ({
  api: {
    cleanup: {
      messages: vi.fn(() =>
        Promise.resolve({
          slice: 'large',
          domain: 'foo.com',
          messages,
          total: 2,
          totalBytes: 30,
          truncated: false,
        }),
      ),
      queueStatus: vi.fn(() => Promise.resolve({ pending: 0, failed: 0, done: 0 })),
      keep: vi.fn(() => Promise.resolve({ updated: 1 })),
    },
  },
}));

const URL = '/cleanup/messages?slice=large&domain=foo.com&minMb=10';

async function mountDrill() {
  const { CleanupMessages } = await import('./CleanupMessages');
  return render(
    <MemoryRouter initialEntries={[URL]}>
      <Routes>
        <Route path="/cleanup/messages" element={<CleanupMessages />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** The checkbox state of the row whose subject is `text`. */
function rowChecked(text: string): boolean {
  const button = screen.getByText(text).closest('button')!;
  return (button.querySelector('input[type="checkbox"]') as HTMLInputElement).checked;
}

beforeEach(() => {
  cleanup();
});

describe('CleanupMessages selection persistence', () => {
  test('a deselection survives unmount + remount of the same drill', async () => {
    await mountDrill();
    await screen.findByText('First');
    // Everything starts checked.
    expect(rowChecked('First')).toBe(true);
    expect(rowChecked('Second')).toBe(true);

    // Deselect the first row.
    fireEvent.click(screen.getByText('First'));
    await waitFor(() => expect(rowChecked('First')).toBe(false));

    // Simulate opening a message + coming back: unmount, then remount the same drill.
    cleanup();
    await mountDrill();
    await screen.findByText('First');

    expect(rowChecked('First')).toBe(false);
    expect(rowChecked('Second')).toBe(true);
  });
});
