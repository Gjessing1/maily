import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { usePullToRefresh } from './usePullToRefresh';

/** A scrollable list whose scroll position and pull state the tests can drive/read. */
function List({
  onRefresh,
  scrollTop = 0,
  enabled = true,
  busy = false,
}: {
  onRefresh: () => void;
  scrollTop?: number;
  enabled?: boolean;
  busy?: boolean;
}) {
  const pull = usePullToRefresh(onRefresh, { enabled, busy });
  return (
    <div
      data-testid="list"
      // jsdom leaves scrollTop at 0 and ignores writes, so the fixture supplies it.
      ref={(el) => {
        if (el) Object.defineProperty(el, 'scrollTop', { value: scrollTop, configurable: true });
      }}
      {...pull.handlers}
    >
      <span data-testid="distance">{Math.round(pull.distance)}</span>
      <span data-testid="progress">{pull.progress.toFixed(2)}</span>
      <span data-testid="refreshing">{String(pull.refreshing)}</span>
    </div>
  );
}

type Point = { x: number; y: number };
const touches = (points: Point[]) => ({
  touches: points.map((p) => ({ clientX: p.x, clientY: p.y })),
});

function drag(el: HTMLElement, from: Point, ...path: Point[]) {
  act(() => void fireEvent.touchStart(el, touches([from])));
  for (const point of path) act(() => void fireEvent.touchMove(el, touches([point])));
}

function release(el: HTMLElement) {
  act(() => void fireEvent.touchEnd(el, { touches: [] }));
}

describe('usePullToRefresh', () => {
  it('follows the finger with resistance and reports progress', () => {
    const view = render(<List onRefresh={vi.fn()} />);
    const list = view.getByTestId('list');

    drag(list, { x: 100, y: 100 }, { x: 100, y: 164 });
    // 64px of travel, halved by the rubber-band resistance.
    expect(view.getByTestId('distance').textContent).toBe('32');
    expect(view.getByTestId('progress').textContent).toBe('0.50');
  });

  it('refreshes when the pull passes the trigger point', () => {
    const onRefresh = vi.fn();
    const view = render(<List onRefresh={onRefresh} busy />);
    const list = view.getByTestId('list');

    drag(list, { x: 100, y: 100 }, { x: 100, y: 240 });
    release(list);

    expect(onRefresh).toHaveBeenCalledOnce();
    expect(view.getByTestId('refreshing').textContent).toBe('true');
  });

  it('snaps back without refreshing when released short of the trigger', () => {
    const onRefresh = vi.fn();
    const view = render(<List onRefresh={onRefresh} />);
    const list = view.getByTestId('list');

    drag(list, { x: 100, y: 100 }, { x: 100, y: 150 });
    release(list);

    expect(onRefresh).not.toHaveBeenCalled();
    expect(view.getByTestId('distance').textContent).toBe('0');
  });

  it('ignores a drag that starts below the top of the list', () => {
    const onRefresh = vi.fn();
    const view = render(<List onRefresh={onRefresh} scrollTop={240} />);
    const list = view.getByTestId('list');

    drag(list, { x: 100, y: 100 }, { x: 100, y: 300 });
    release(list);

    expect(view.getByTestId('distance').textContent).toBe('0');
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('leaves a horizontal swipe to the row underneath', () => {
    const onRefresh = vi.fn();
    const view = render(<List onRefresh={onRefresh} />);
    const list = view.getByTestId('list');

    // Sideways first, then down: the row's swipe already owns this gesture.
    drag(list, { x: 100, y: 100 }, { x: 160, y: 104 }, { x: 160, y: 260 });
    release(list);

    expect(view.getByTestId('distance').textContent).toBe('0');
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('does not arm while disabled', () => {
    const onRefresh = vi.fn();
    const view = render(<List onRefresh={onRefresh} enabled={false} />);
    const list = view.getByTestId('list');

    drag(list, { x: 100, y: 100 }, { x: 100, y: 300 });
    release(list);

    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('holds the spinner until the caller is done and the minimum time has passed', () => {
    vi.useFakeTimers();
    try {
      const onRefresh = vi.fn();
      const view = render(<List onRefresh={onRefresh} busy={false} />);
      const list = view.getByTestId('list');

      drag(list, { x: 100, y: 100 }, { x: 100, y: 240 });
      release(list);
      expect(view.getByTestId('refreshing').textContent).toBe('true');

      // An instant refresh still shows the spinner for the minimum window.
      act(() => void vi.advanceTimersByTime(400));
      expect(view.getByTestId('refreshing').textContent).toBe('true');
      act(() => void vi.advanceTimersByTime(200));
      expect(view.getByTestId('refreshing').textContent).toBe('false');
    } finally {
      vi.useRealTimers();
    }
  });
});
