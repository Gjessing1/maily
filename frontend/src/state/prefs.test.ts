/**
 * Prefs sync by merge patch: a device pushes only the keys it changed, so a tab left open can't
 * revert an edit made on another device, and device-only prefs never leave the device.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const api = vi.hoisted(() => ({ getSettings: vi.fn(), patchSettings: vi.fn() }));
vi.mock('../api/client', () => ({ api }));

/** A fresh module, as after a reload: state comes only from localStorage. */
async function loadPrefs() {
  vi.resetModules();
  return import('./prefs');
}

beforeEach(() => {
  localStorage.clear();
  api.getSettings.mockReset();
  api.patchSettings.mockReset().mockResolvedValue({ ok: true });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('prefs sync', () => {
  test('a change pushes only the keys that changed', async () => {
    const prefs = await loadPrefs();
    prefs.setPref('theme', 'dark');
    prefs.setPref('signature', 'Lars');
    await vi.advanceTimersByTimeAsync(600);
    expect(api.patchSettings).toHaveBeenCalledTimes(1);
    expect(api.patchSettings).toHaveBeenCalledWith({ theme: 'dark', signature: 'Lars' });
  });

  test('device-only prefs are never pushed and ignore the server copy', async () => {
    const prefs = await loadPrefs();
    prefs.setPref('clientCacheDays', 7);
    await vi.advanceTimersByTimeAsync(600);
    expect(api.patchSettings).not.toHaveBeenCalled();

    api.getSettings.mockResolvedValue({ theme: 'dark', clientCacheDays: 365 });
    await prefs.hydratePrefs();
    expect(prefs.getPrefs().theme).toBe('dark');
    expect(prefs.getPrefs().clientCacheDays).toBe(7);
  });

  test('hydration keeps an unconfirmed edit and pushes it again', async () => {
    const prefs = await loadPrefs();
    api.patchSettings.mockRejectedValueOnce(new Error('offline'));
    prefs.setPref('theme', 'dark');
    await vi.advanceTimersByTimeAsync(600);

    api.getSettings.mockResolvedValue({ theme: 'light', unreadAtTop: false });
    await prefs.hydratePrefs();
    expect(prefs.getPrefs().theme).toBe('dark');
    expect(prefs.getPrefs().unreadAtTop).toBe(false);

    await vi.advanceTimersByTimeAsync(600);
    expect(api.patchSettings).toHaveBeenLastCalledWith({ theme: 'dark' });
  });

  test('an unconfirmed edit survives a reload', async () => {
    api.patchSettings.mockRejectedValue(new Error('offline'));
    (await loadPrefs()).setPref('theme', 'dark');
    await vi.advanceTimersByTimeAsync(600);

    const reloaded = await loadPrefs();
    api.getSettings.mockResolvedValue({ theme: 'light' });
    await reloaded.hydratePrefs();
    expect(reloaded.getPrefs().theme).toBe('dark');
  });

  test('a read that started before a push landed is discarded', async () => {
    const prefs = await loadPrefs();
    let respond: (value: Record<string, unknown>) => void = () => undefined;
    api.getSettings.mockReturnValue(new Promise((resolve) => (respond = resolve)));
    const hydration = prefs.hydratePrefs();

    prefs.setPref('theme', 'dark');
    await vi.advanceTimersByTimeAsync(600);
    expect(api.patchSettings).toHaveBeenCalledWith({ theme: 'dark' });

    respond({ theme: 'light' });
    await hydration;
    expect(prefs.getPrefs().theme).toBe('dark');
  });
});
