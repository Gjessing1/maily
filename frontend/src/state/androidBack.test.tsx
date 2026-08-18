import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { registerBackHandler, resetBackHandlers } from './backButton';

/** The Android press, captured from the fake bridge so tests can fire it directly. */
let pressBack: (() => void) | null = null;
const exitNativeApp = vi.fn();

vi.mock('../nativeAndroid', () => ({
  onNativeBack: (handler: () => void) => {
    pressBack = handler;
    return () => {
      pressBack = null;
    };
  },
  exitNativeApp: () => exitNativeApp(),
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

const back = () => act(() => pressBack?.());

beforeEach(() => {
  resetBackHandlers();
  exitNativeApp.mockClear();
  // MemoryRouter never stamps window.history, so these tests exercise the
  // navigation-type depth fallback rather than the `idx` fast path.
  window.history.replaceState(null, '');
});

describe('useAndroidBackButton', () => {
  it('leaves the app from the root screen', () => {
    mount();
    back();
    expect(exitNativeApp).toHaveBeenCalledOnce();
  });

  it('pops a pushed screen instead of leaving', () => {
    const view = mount();
    act(() => view.getByText('open message').click());
    expect(view.getByTestId('path').textContent).toBe('/m/1');

    back();
    expect(view.getByTestId('path').textContent).toBe('/');
    expect(exitNativeApp).not.toHaveBeenCalled();
  });

  it('leaves only once the stack is unwound back to the root', () => {
    const view = mount();
    act(() => view.getByText('open message').click());
    back();
    back();
    expect(exitNativeApp).toHaveBeenCalledOnce();
  });

  it('routes a deep link opened as the first entry to the inbox, not out of the app', () => {
    const view = mount('/m/1');
    back();
    expect(view.getByTestId('path').textContent).toBe('/');
    expect(exitNativeApp).not.toHaveBeenCalled();
  });

  it('lets a registered overlay consume the press', () => {
    const dismiss = vi.fn();
    const view = mount();
    registerBackHandler(dismiss);

    back();
    expect(dismiss).toHaveBeenCalledOnce();
    expect(exitNativeApp).not.toHaveBeenCalled();
    expect(view.getByTestId('path').textContent).toBe('/');
  });

  it('prefers React Router’s stamped history index over the local counter', () => {
    // A reload mid-stack starts the counter at zero while the entry still knows its depth.
    window.history.replaceState({ idx: 3 }, '');
    const view = mount('/m/1');
    back();
    // Popped rather than redirected to the inbox: there is real history behind us.
    expect(view.getByTestId('path').textContent).toBe('/m/1');
    expect(exitNativeApp).not.toHaveBeenCalled();
  });
});
