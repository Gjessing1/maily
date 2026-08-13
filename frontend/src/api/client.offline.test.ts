import { afterEach, describe, expect, test, vi } from 'vitest';
import { api, type ApiError } from './client';
import { OFFLINE_READ_ONLY_MESSAGE } from '../state/connectivity';

function setOnline(value: boolean): void {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value });
}

afterEach(() => {
  setOnline(true);
  vi.unstubAllGlobals();
});

describe('offline API boundary', () => {
  test('rejects a mutation before it reaches fetch', async () => {
    setOnline(false);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await expect(api.setFlags('message-1', { seen: true })).rejects.toEqual(
      expect.objectContaining<Partial<ApiError>>({
        status: 0,
        message: OFFLINE_READ_ONLY_MESSAGE,
      }),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  test('fails a GET immediately instead of retrying while offline', async () => {
    setOnline(false);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await expect(api.accounts()).rejects.toEqual(
      expect.objectContaining<Partial<ApiError>>({ status: 0, message: 'offline' }),
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
