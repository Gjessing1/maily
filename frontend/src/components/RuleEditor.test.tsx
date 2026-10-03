/**
 * The rule sheet saves without touching existing mail unless "Also apply now" is ticked, and
 * then runs the apply passes for the rule it just saved.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import type { MailRule } from '@maily/shared';

const api = vi.hoisted(() => ({
  rules: {
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    preview: vi.fn(),
    apply: vi.fn(),
  },
}));
vi.mock('../api/client', () => ({ api, ApiError: class extends Error {} }));
vi.mock('../state/data', () => ({ useAccounts: () => [] }));
const showNotice = vi.hoisted(() => vi.fn());
vi.mock('../state/undo', () => ({ showNotice }));

const { RuleEditor } = await import('./RuleEditor');

const saved: MailRule = {
  id: 'new',
  accountId: null,
  matchKind: 'sender',
  matchValue: 'news@shop.example',
  move: 'archive',
  markRead: false,
  star: false,
  enabled: true,
  hits: 0,
  lastHitAt: null,
  createdAt: 1,
};

beforeEach(() => {
  for (const fn of Object.values(api.rules)) fn.mockReset();
  showNotice.mockReset();
  api.rules.preview.mockResolvedValue({
    count: 2,
    sample: [{ id: 'm1', fromAddress: 'news@shop.example', subject: 'Sale', receivedAt: 1 }],
  });
  api.rules.create.mockResolvedValue(saved);
  api.rules.apply.mockResolvedValue({ applied: 2, remaining: 0 });
});

function open(onClose = vi.fn()) {
  render(
    <RuleEditor
      rule={null}
      seed={{ matchKind: 'sender', matchValue: 'news@shop.example' }}
      onClose={onClose}
    />,
  );
  return onClose;
}

test('Save stays off until the rule has an action', () => {
  open();
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
  expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
});

test('saving leaves existing inbox mail alone by default', async () => {
  const onClose = open();
  fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
  await screen.findByText(/matching messages in your inbox now/);

  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(api.rules.create).toHaveBeenCalledWith(
    expect.objectContaining({ matchValue: 'news@shop.example', move: 'archive' }),
  );
  expect(api.rules.apply).not.toHaveBeenCalled();
});

test('"Also apply now" runs the saved rule over the matching inbox mail', async () => {
  const onClose = open();
  fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
  fireEvent.click(await screen.findByRole('checkbox'));

  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(api.rules.apply).toHaveBeenCalledWith('new');
  expect(showNotice).toHaveBeenCalledWith('Rule saved · applied to 2 messages');
});

test('a refused save keeps the sheet open with the server’s reason', async () => {
  api.rules.create.mockRejectedValue(new Error('{"error":"a rule for this match already exists"}'));
  const onClose = open();
  fireEvent.click(screen.getByRole('button', { name: 'Spam' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('a rule for this match already exists')).toBeInTheDocument();
  expect(onClose).not.toHaveBeenCalled();
});
