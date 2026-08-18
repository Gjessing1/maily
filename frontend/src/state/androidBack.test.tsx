import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { registerBackHandler, resetBackHandlers } from './backButton';

/** The handler the app installs for the shell, captured so tests can ask it directly. */
let pressBack: (() => boolean) | null = null;

vi.mock('../nativeAndroid', () => ({
  setNativeBackHandler: (handler: () => boolean) => {
    pressBack = handler;
    return () => {
      pressBack = null;
    };
  },
}));

const { useAndroidBackButton } = await import('./androidBack');

function Harness() {
  useAndroidBackButton();
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <div>
      <span data-testid="path">{location.pathname}</span>
      <button onClick={() => navigate('/m/1')}>open message</button>
      <Routes>
        <Route path="/" element={<span>inbox</span>} />
        <Route path="/m/:id" element={<span>message</span>} />
      </Routes>
    </div>
  );
}

function mount(at = '/') {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <Harness />
    </MemoryRouter>,
  );
}

/** Press Back the way the shell does, and report whether the app consumed it. */
function back(): boolean {
  let consumed = false;
  act(() => {
    consumed = pressBack?.() ?? false;
  });
  return consumed;
}

beforeEach(() => {
  resetBackHandlers();
  // MemoryRouter never stamps window.history, so these tests exercise the
  // navigation-type depth fallback rather than the `idx` fast path.
  window.history.replaceState(null, '');
});

describe('useAndroidBackButton', () => {
  it('declines the press from the root screen, so the shell leaves the app', () => {
    mount();
    expect(back()).toBe(false);
  });

  it('pops a pushed screen instead of leaving', () => {
    const view = mount();
    act(() => view.getByText('open message').click());
    expect(view.getByTestId('path').textContent).toBe('/m/1');

    expect(back()).toBe(true);
    expect(view.getByTestId('path').textContent).toBe('/');
  });

  it('declines only once the stack is unwound back to the root', () => {
    const view = mount();
    act(() => view.getByText('open message').click());
    expect(back()).toBe(true);
    expect(back()).toBe(false);
  });

  it('routes a deep link opened as the first entry to the inbox, not out of the app', () => {
    const view = mount('/m/1');
    expect(back()).toBe(true);
    expect(view.getByTestId('path').textContent).toBe('/');
  });

  it('lets a registered overlay consume the press', () => {
    const dismiss = vi.fn();
    const view = mount();
    registerBackHandler(dismiss);

    expect(back()).toBe(true);
    expect(dismiss).toHaveBeenCalledOnce();
    expect(view.getByTestId('path').textContent).toBe('/');
  });

  it('prefers React Router’s stamped history index over the local counter', () => {
    // A reload mid-stack starts the counter at zero while the entry still knows its depth.
    window.history.replaceState({ idx: 3 }, '');
    const view = mount('/m/1');
    expect(back()).toBe(true);
    // Popped rather than redirected to the inbox: there is real history behind us.
    expect(view.getByTestId('path').textContent).toBe('/m/1');
  });

  it('uninstalls the handler when the app unmounts', () => {
    const view = mount();
    view.unmount();
    expect(pressBack).toBeNull();
  });
});
