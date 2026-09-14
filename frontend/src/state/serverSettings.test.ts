/**
 * A server setting changes only when the server accepts the change: the screen shows it at once,
 * adopts what the server stored, and a failed save puts the previous value back and says so.
 */
import { beforeEach, expect, test, vi } from 'vitest';

const api = vi.hoisted(() => ({ serverSettings: vi.fn(), patchServerSettings: vi.fn() }));
const showNotice = vi.hoisted(() => vi.fn());
vi.mock('../api/client', () => ({ api }));
vi.mock('./undo', () => ({ showNotice }));

const DEFAULTS = {
  cleanupProtectedKeywords: [],
  cleanupNewsletterKeywords: [],
  cleanupColdKeepKeywords: [],
  undoSendSeconds: 10,
};

async function loadServerSettings() {
  vi.resetModules();
  return import('./serverSettings');
}

beforeEach(() => {
  localStorage.clear();
  api.serverSettings.mockReset();
  api.patchServerSettings.mockReset();
  showNotice.mockReset();
});

test('a saved change adopts what the server stored', async () => {
  const settings = await loadServerSettings();
  api.patchServerSettings.mockResolvedValue({
    ...DEFAULTS,
    cleanupProtectedKeywords: ['warranty'],
  });

  const saving = settings.updateServerSettings({ cleanupProtectedKeywords: [' Warranty'] });
  expect(settings.getServerSettings().cleanupProtectedKeywords).toEqual([' Warranty']);
  expect(await saving).toBe(true);
  expect(settings.getServerSettings().cleanupProtectedKeywords).toEqual(['warranty']);
});

test('a failed save restores the previous value and tells the user', async () => {
  const settings = await loadServerSettings();
  api.patchServerSettings.mockRejectedValue(new Error('offline'));

  const saving = settings.updateServerSettings({ undoSendSeconds: 0 });
  expect(settings.getServerSettings().undoSendSeconds).toBe(0);
  expect(await saving).toBe(false);
  expect(settings.getServerSettings().undoSendSeconds).toBe(10);
  expect(showNotice).toHaveBeenCalledOnce();
});
