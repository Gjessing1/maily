/**
 * Inside the APK the OS media query is frozen at whatever the device was in when the
 * WebView was built, so "follow the system" only ever moved after a force-close. What
 * is pinned here is that the shell's report moves it instead — and that it is confined
 * to the 'system' pref, which is the whole point of an explicit light/dark choice.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Theme } from './prefs';

let pref: Theme = 'system';
vi.mock('./prefs', () => ({ usePrefs: () => ({ theme: pref }) }));

const { useTheme } = await import('./theme');

/** Play the shell: evaluate the global it installs in the WebView. */
function deviceFlipsTo(theme: 'dark' | 'light'): void {
  const report = (globalThis as { mailySystemTheme?: (t: 'dark' | 'light') => void })
    .mailySystemTheme;
  expect(report).toBeTypeOf('function');
  act(() => report?.(theme));
}

describe('the resolved theme', () => {
  it('follows the mode the Android shell reports, not the frozen media query', () => {
    pref = 'system';
    // jsdom's stub answers a non-matching (light) query — as a stale WebView would.
    const { result } = renderHook(() => useTheme());
    expect(result.current).toBe('light');

    deviceFlipsTo('dark');
    expect(result.current).toBe('dark');

    deviceFlipsTo('light');
    expect(result.current).toBe('light');
  });

  it('leaves an explicit pref alone', () => {
    pref = 'light';
    const { result } = renderHook(() => useTheme());
    deviceFlipsTo('dark');
    expect(result.current).toBe('light');
  });
});
