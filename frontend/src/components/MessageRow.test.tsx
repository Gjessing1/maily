/**
 * Swipe-action behaviour for the message list row (Refactoring Phase 5d). The
 * gesture maths is fiddly and security-adjacent only in the sense that a wrong
 * commit deletes mail, so the commit thresholds + direction→action mapping are
 * pinned here: a right swipe past the commit distance fires `swipeRight`, a left
 * swipe fires `swipeLeft`, and a short drag below the threshold fires nothing.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';
import type { MessageDto } from '@maily/shared';
import { MessageRow } from './MessageRow';

function makeMessage(overrides: Partial<MessageDto> = {}): MessageDto {
  return {
    id: 'msg-1',
    accountId: 'acc-1',
    threadId: null,
    subject: 'Hello there',
    fromName: 'Alice',
    fromAddress: 'alice@example.com',
    to: [],
    snippet: 'a snippet',
    sentAt: '2025-06-01T00:00:00.000Z',
    receivedAt: '2025-06-01T00:00:00.000Z',
    seen: false,
    flagged: false,
    folderIds: [],
    attachments: [],
    ...overrides,
  };
}

/** The element carrying the touch handlers is the swipe wrapper around the row Link. */
function swipeSurface(): HTMLElement {
  const link = screen.getByRole('link');
  return link.parentElement as HTMLElement;
}

/** Drive a full swipe gesture of `delta` px (positive = right, negative = left). */
function swipe(el: HTMLElement, delta: number): void {
  fireEvent.touchStart(el, { touches: [{ clientX: 0 }] });
  fireEvent.touchMove(el, { touches: [{ clientX: delta }] });
  fireEvent.touchEnd(el);
}

function renderRow(props: Parameters<typeof MessageRow>[0]) {
  return render(
    <MemoryRouter>
      <MessageRow {...props} />
    </MemoryRouter>,
  );
}

describe('MessageRow swipe', () => {
  test('a right swipe past the commit distance fires the read toggle', () => {
    const onToggleRead = vi.fn();
    const onDelete = vi.fn();
    renderRow({
      message: makeMessage({ seen: false }),
      onToggleRead,
      onDelete,
      swipeRight: 'read',
      swipeLeft: 'delete',
    });

    swipe(swipeSurface(), 110);

    expect(onToggleRead).toHaveBeenCalledWith('msg-1', true); // !seen → mark read
    expect(onDelete).not.toHaveBeenCalled();
  });

  test('a left swipe past the commit distance fires delete', () => {
    const onToggleRead = vi.fn();
    const onDelete = vi.fn();
    renderRow({
      message: makeMessage(),
      onToggleRead,
      onDelete,
      swipeRight: 'read',
      swipeLeft: 'delete',
    });

    swipe(swipeSurface(), -110);

    expect(onDelete).toHaveBeenCalledWith('msg-1');
    expect(onToggleRead).not.toHaveBeenCalled();
  });

  test('a short drag below the commit threshold fires nothing', () => {
    const onToggleRead = vi.fn();
    const onDelete = vi.fn();
    renderRow({ message: makeMessage(), onToggleRead, onDelete });

    swipe(swipeSurface(), 40);

    expect(onToggleRead).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });

  test('swiping is suppressed in selection mode', () => {
    const onToggleRead = vi.fn();
    const onDelete = vi.fn();
    renderRow({
      message: makeMessage(),
      onToggleRead,
      onDelete,
      selectionMode: true,
    });

    swipe(swipeSurface(), 110);
    swipe(swipeSurface(), -110);

    expect(onToggleRead).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });
});
