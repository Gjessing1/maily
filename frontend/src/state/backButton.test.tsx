import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { useState } from 'react';
import {
  registerBackHandler,
  resetBackHandlers,
  runBackHandler,
  useBackHandler,
} from './backButton';

beforeEach(() => resetBackHandlers());

describe('back handler registry', () => {
  it('reports an unhandled press when nothing is registered', () => {
    expect(runBackHandler()).toBe(false);
  });

  it('runs only the innermost handler', () => {
    const outer = vi.fn();
    const inner = vi.fn();
    registerBackHandler(outer);
    registerBackHandler(inner);

    expect(runBackHandler()).toBe(true);
    expect(inner).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();
  });

  it('falls back to the outer handler once the inner one unregisters', () => {
    const outer = vi.fn();
    const inner = vi.fn();
    registerBackHandler(outer);
    const removeInner = registerBackHandler(inner);

    removeInner();
    expect(runBackHandler()).toBe(true);
    expect(outer).toHaveBeenCalledOnce();
  });

  it('unregistering twice does not drop someone else’s handler', () => {
    const first = vi.fn();
    const remove = registerBackHandler(first);
    const second = vi.fn();
    registerBackHandler(second);

    remove();
    remove();

    expect(runBackHandler()).toBe(true);
    expect(second).toHaveBeenCalledOnce();
  });
});

describe('useBackHandler', () => {
  /** Two overlays over one screen; each claims Back only while it is open. */
  function Screen({ onLeave }: { onLeave: () => void }) {
    const [drawer, setDrawer] = useState(false);
    const [dialog, setDialog] = useState(false);
    useBackHandler(true, onLeave);
    useBackHandler(drawer, () => setDrawer(false));
    useBackHandler(dialog, () => setDialog(false));
    return (
      <div>
        <button onClick={() => setDrawer(true)}>open drawer</button>
        <button onClick={() => setDialog(true)}>open dialog</button>
        <span data-testid="open">{`${drawer ? 'drawer' : ''} ${dialog ? 'dialog' : ''}`}</span>
      </div>
    );
  }

  it('dismisses overlays in the order they were opened, newest first', () => {
    const leave = vi.fn();
    const view = render(<Screen onLeave={leave} />);

    act(() => view.getByText('open drawer').click());
    act(() => view.getByText('open dialog').click());

    // Dialog opened last, so it goes first even though the drawer's hook is declared earlier.
    act(() => void runBackHandler());
    expect(view.getByTestId('open').textContent).toBe('drawer ');

    act(() => void runBackHandler());
    expect(view.getByTestId('open').textContent).toBe(' ');
    expect(leave).not.toHaveBeenCalled();

    // Nothing transient left — the screen's own handler takes the press.
    act(() => void runBackHandler());
    expect(leave).toHaveBeenCalledOnce();
  });

  it('drops its registration when the component unmounts', () => {
    const leave = vi.fn();
    render(<Screen onLeave={leave} />).unmount();
    expect(runBackHandler()).toBe(false);
  });

  it('calls the latest callback, not the one captured at registration', () => {
    const first = vi.fn();
    const second = vi.fn();
    function Latest({ onBack }: { onBack: () => void }) {
      useBackHandler(true, onBack);
      return null;
    }
    const view = render(<Latest onBack={first} />);
    view.rerender(<Latest onBack={second} />);

    act(() => void runBackHandler());
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });
});
