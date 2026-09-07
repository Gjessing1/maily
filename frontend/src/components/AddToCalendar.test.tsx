/**
 * "Add to calendar" form behaviour: the event target and the date fields — the two
 * things a user notices immediately when they're wrong. Pins that the sheet writes
 * to the server's default calendar, that the end is never left blank (a draft with
 * no end is a same-day event), and that moving the start drags the end with it.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { CalendarSettingsDto, EventDraftDto } from '@maily/shared';

const calendars: CalendarSettingsDto = {
  calendars: [
    { href: 'https://dav.example.com/lars/tasks/', displayName: 'Tasks' },
    { href: 'https://dav.example.com/lars/personal/', displayName: 'Kalender' },
  ],
  default: 'https://dav.example.com/lars/personal/',
};

/** Bare-message draft: a subject and nothing else — the common "add this mail" case. */
const bareDraft: EventDraftDto = {
  summary: 'Dentist',
  start: null,
  end: null,
  location: null,
  description: null,
  source: 'message',
};

const addToCalendar = vi.fn(() =>
  Promise.resolve({ ok: true, calendar: 'https://dav.example.com/lars/personal/' }),
);
const eventDrafts = vi.fn(() => Promise.resolve([bareDraft]));

vi.mock('../api/client', () => ({
  api: {
    calendars: () => Promise.resolve(calendars),
    eventDrafts: (id: string) => eventDrafts(id),
    addToCalendar: (id: string, input: unknown) => addToCalendar(id, input),
  },
}));

const dateField = (label: string) =>
  screen.getByText(label).parentElement!.querySelector('input[type="date"]') as HTMLInputElement;
const timeField = (label: string) =>
  screen.getByText(label).closest('div')!.querySelectorAll('input[type="time"]');

async function openSheet(title = 'Dentist') {
  const { AddToCalendar } = await import('./AddToCalendar');
  render(<AddToCalendar messageId="message-1" onClose={() => undefined} />);
  await screen.findByDisplayValue(title);
}

beforeEach(() => {
  vi.clearAllMocks();
  eventDrafts.mockResolvedValue([bareDraft]);
});

describe('AddToCalendar', () => {
  test('pre-selects the server default calendar and adds the event there', async () => {
    await openSheet();

    const picker = screen.getByText('Calendar').parentElement!.querySelector('select')!;
    expect(picker).toHaveValue('https://dav.example.com/lars/personal/');

    fireEvent.click(screen.getByRole('button', { name: 'Add event' }));
    await waitFor(() => expect(addToCalendar).toHaveBeenCalled());
    expect(addToCalendar.mock.calls[0]![1]).toMatchObject({
      calendar: 'https://dav.example.com/lars/personal/',
    });
  });

  test('a draft with no end starts out same-day, an hour long', async () => {
    await openSheet();

    const start = dateField('Starts');
    expect(dateField('Ends')).toHaveValue(start.value);
    expect(timeField('Starts')[0]).toHaveValue('09:00');
    expect(timeField('Ends')[0]).toHaveValue('10:00');
  });

  test('moving the start date moves the end date with it', async () => {
    await openSheet();

    fireEvent.change(dateField('Starts'), { target: { value: '2026-03-14' } });
    expect(dateField('Ends')).toHaveValue('2026-03-14');

    // A multi-day span keeps its length rather than collapsing onto the new start.
    fireEvent.change(dateField('Ends'), { target: { value: '2026-03-16' } });
    fireEvent.change(dateField('Starts'), { target: { value: '2026-03-20' } });
    expect(dateField('Ends')).toHaveValue('2026-03-22');
  });

  test('moving the start time moves the end time, rolling past midnight', async () => {
    await openSheet();

    fireEvent.change(dateField('Starts'), { target: { value: '2026-03-14' } });
    fireEvent.change(timeField('Starts')[0]!, { target: { value: '23:30' } });
    expect(timeField('Ends')[0]).toHaveValue('00:30');
    expect(dateField('Ends')).toHaveValue('2026-03-15');
  });

  test('sends a timed same-day event with a real end', async () => {
    await openSheet();

    fireEvent.change(dateField('Starts'), { target: { value: '2026-03-14' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add event' }));

    await waitFor(() => expect(addToCalendar).toHaveBeenCalled());
    expect(addToCalendar.mock.calls[0]![1]).toMatchObject({
      start: '2026-03-14T09:00',
      end: '2026-03-14T10:00',
    });
  });

  test('an all-day invite shows the inclusive last day and round-trips it', async () => {
    // DTSTART 2026-05-01, DTEND 2026-05-04 (exclusive) = three days through the 3rd.
    eventDrafts.mockResolvedValue([
      { ...bareDraft, summary: 'Conference', start: '2026-05-01', end: '2026-05-04' },
    ]);
    await openSheet('Conference');

    expect(dateField('Starts')).toHaveValue('2026-05-01');
    expect(dateField('Ends')).toHaveValue('2026-05-03');

    fireEvent.click(screen.getByRole('button', { name: 'Add event' }));
    await waitFor(() => expect(addToCalendar).toHaveBeenCalled());
    expect(addToCalendar.mock.calls[0]![1]).toMatchObject({
      start: '2026-05-01',
      end: '2026-05-04',
    });
  });

  test('refuses an end before the start', async () => {
    await openSheet();

    fireEvent.change(dateField('Starts'), { target: { value: '2026-03-14' } });
    fireEvent.change(dateField('Ends'), { target: { value: '2026-03-10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add event' }));

    expect(await screen.findByText(/end can’t be before the start/i)).toBeInTheDocument();
    expect(addToCalendar).not.toHaveBeenCalled();
  });
});
