import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, SERVER_UNREACHABLE_MESSAGE, type ApiError } from './client';
import { isServerReachable, resetServerReachable } from '../state/connectivity';

const CLOUDFLARE_PAGE =
  '<!DOCTYPE html><html><head><title>Origin unreachable</title></head></html>';

function respond(body: string, status: number, type: string): Response {
  return new Response(body, { status, headers: { 'content-type': type } });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetServerReachable();
});

describe('unreachable server', () => {
  test('a proxy error page marks the server unreachable without leaking its HTML', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(CLOUDFLARE_PAGE, 530, 'text/html')));

    await expect(api.accounts()).rejects.toEqual(
      expect.objectContaining<Partial<ApiError>>({
        status: 530,
        message: SERVER_UNREACHABLE_MESSAGE,
      }),
    );
    expect(isServerReachable()).toBe(false);
  });

  test("maily's own JSON 503 is an ordinary error, not an outage", async () => {
    const body = JSON.stringify({ error: 'IMAP upstream unavailable' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(body, 503, 'application/json')));

    await expect(api.accounts()).rejects.toEqual(
      expect.objectContaining<Partial<ApiError>>({ status: 503, message: body }),
    );
    expect(isServerReachable()).toBe(true);
  });

  test('a failed GET retry means unreachable; the next success restores it', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(respond('[]', 200, 'application/json'));
    vi.stubGlobal('fetch', fetch);

    const first = api.accounts();
    const assertion = expect(first).rejects.toEqual(
      expect.objectContaining<Partial<ApiError>>({ message: SERVER_UNREACHABLE_MESSAGE }),
    );
    await vi.advanceTimersByTimeAsync(1000); // the retry delay
    await assertion;
    expect(isServerReachable()).toBe(false);

    await expect(api.accounts()).resolves.toEqual([]);
    expect(isServerReachable()).toBe(true);
  });

  test('the auth probe opens cached mail on a down server instead of navigating', async () => {
    localStorage.setItem('maily.offlineAccess', 'true');
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    await expect(api.authConfig()).resolves.toEqual({ authRequired: false });
    expect(assign).not.toHaveBeenCalled();
    expect(isServerReachable()).toBe(false);
    localStorage.removeItem('maily.offlineAccess');
  });

  test('an HTML error for a non-GET is reported as unreachable too', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(CLOUDFLARE_PAGE, 502, 'text/html')));

    await expect(api.setFlags('m1', { seen: true })).rejects.toEqual(
      expect.objectContaining<Partial<ApiError>>({ message: SERVER_UNREACHABLE_MESSAGE }),
    );
  });
});
