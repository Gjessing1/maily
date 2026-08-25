import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ContactCardDto, ContactEmailIntelligenceDto } from '@maily/shared';

const card: ContactCardDto = {
  uid: 'contact-1',
  name: 'Alice Example',
  emails: ['alice@example.com', 'alice@work.example'],
  addressbook: '/contacts/',
  addressbookName: 'Contacts',
  nickname: null,
  org: null,
  title: null,
  phones: [],
  urls: [],
  addresses: [],
  birthday: null,
  note: null,
  categories: [],
  photo: null,
};

const intelligence: ContactEmailIntelligenceDto = {
  messageCount: 7,
  conversationCount: 3,
  firstCommunicationAt: '2025-01-01T10:00:00.000Z',
  lastReceivedAt: '2025-03-01T10:00:00.000Z',
  lastSentAt: '2025-03-02T10:00:00.000Z',
  timeline: [
    {
      messageId: 'message-1',
      accountId: 'account-1',
      threadId: 'thread-1',
      subject: 'Project update',
      snippet: 'Here is the latest update',
      occurredAt: '2025-03-02T10:00:00.000Z',
      direction: 'sent',
      attachmentCount: 1,
    },
  ],
  recentAttachments: [
    {
      messageId: 'message-1',
      subject: 'Project update',
      occurredAt: '2025-03-02T10:00:00.000Z',
      direction: 'sent',
      attachment: {
        id: 'attachment-1',
        filename: 'project.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 2048,
        isInline: false,
        downloaded: false,
      },
    },
  ],
};

vi.mock('../api/client', () => ({
  api: {
    contactCard: vi.fn(() => Promise.resolve(card)),
    contactDuplicates: vi.fn(() => Promise.resolve([])),
    contactEmailIntelligence: vi.fn(() => Promise.resolve(intelligence)),
  },
  attachmentUrl: (messageId: string, attId: string) =>
    `/api/messages/${messageId}/attachments/${attId}`,
  fetchAttachmentBlob: vi.fn(() => Promise.resolve(new Blob(['pdf']))),
  getToken: () => null,
}));

vi.mock('../state/prefs', () => ({
  usePrefs: () => ({ favoriteContacts: [] }),
  getPrefs: () => ({ dateFormat: 'ymd' }),
  setPref: vi.fn(),
}));

let location: ReturnType<typeof useLocation> | null = null;
function LocationSpy() {
  location = useLocation();
  return null;
}

async function renderDetail() {
  const { ContactDetail } = await import('./ContactDetail');
  render(
    <MemoryRouter initialEntries={['/contacts/contact-1']}>
      <LocationSpy />
      <Routes>
        <Route path="/contacts/:uid" element={<ContactDetail />} />
        <Route path="*" element={null} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByRole('heading', { name: 'Email activity' });
}

beforeEach(() => {
  location = null;
});

describe('ContactDetail email intelligence', () => {
  test('shows message/thread stats, recent files and the communication timeline', async () => {
    await renderDetail();

    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('Recent attachments')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /project.pdf/i })).toBeInTheDocument();
    expect(screen.getByText('Communication timeline')).toBeInTheDocument();
    expect(screen.getAllByText('Project update').length).toBeGreaterThan(0);
  });

  test('opens an exact correspondence search for every address on the card', async () => {
    await renderDetail();
    fireEvent.click(screen.getByRole('button', { name: 'Open all conversations with contact' }));

    await waitFor(() => expect(location?.pathname).toBe('/search'));
    expect(new URLSearchParams(location?.search).get('q')).toBe(
      'contact:alice@example.com,alice@work.example',
    );
  });

  test('quick compose prefills the card’s primary address', async () => {
    await renderDetail();
    fireEvent.click(screen.getByRole('button', { name: 'Compose email to contact' }));

    await waitFor(() => expect(location?.pathname).toBe('/compose'));
    expect(location?.state).toEqual({ fresh: true, to: ['alice@example.com'] });
  });
});
