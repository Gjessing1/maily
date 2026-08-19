/**
 * The Android APK cannot use Web Push: System WebView exposes no `PushManager`, so the
 * subscription flow the PWA uses reports "unsupported" and the notifications toggle would
 * be permanently unavailable. On native the same toggle drives FCM instead — the shell
 * returns a device token, which is registered with the backend over this session.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pushKey = vi.fn(() => Promise.resolve({ publicKey: 'vapid', fcm: true }));
const pushRegisterDevice = vi.fn(() => Promise.resolve({ ok: true }));
const pushUnregisterDevice = vi.fn(() => Promise.resolve({ ok: true }));

vi.mock('./client', () => ({
  api: { pushKey, pushRegisterDevice, pushUnregisterDevice },
}));

const getNativePushToken = vi.fn();
const clearNativePushToken = vi.fn(() => Promise.resolve());
let native = true;

vi.mock('../nativeAndroid', () => ({
  isNativeAndroid: () => native,
  getNativePushToken,
  clearNativePushToken,
}));

describe('background notifications in the Android APK', () => {
  beforeEach(() => {
    native = true;
    localStorage.clear();
    vi.clearAllMocks();
    pushKey.mockResolvedValue({ publicKey: 'vapid', fcm: true });
  });

  it('registers the FCM token instead of reporting the WebView unsupported', async () => {
    const { enablePush, pushState } = await import('./push');
    expect(pushState()).toBe('default');

    getNativePushToken.mockResolvedValue({ granted: true, token: 'device-token-1' });
    await expect(enablePush()).resolves.toEqual({ ok: true });

    expect(pushRegisterDevice).toHaveBeenCalledWith('device-token-1');
    // Holding a token IS the on-state: Android has no synchronous permission query.
    expect(pushState()).toBe('granted');
  });

  it('explains a declined permission rather than silently staying off', async () => {
    const { enablePush, pushState } = await import('./push');
    getNativePushToken.mockResolvedValue({ granted: false, token: null });

    const result = await enablePush();
    expect(result.ok).toBe(false);
    expect(result).toHaveProperty('reason');
    expect(pushRegisterDevice).not.toHaveBeenCalled();
    expect(pushState()).toBe('default');
  });

  it('refuses to enable when the server has no Firebase credentials', async () => {
    pushKey.mockResolvedValue({ publicKey: 'vapid', fcm: false });
    const { enablePush } = await import('./push');

    const result = await enablePush();
    expect(result.ok).toBe(false);
    expect(getNativePushToken).not.toHaveBeenCalled();
    expect(pushRegisterDevice).not.toHaveBeenCalled();
  });

  it('unregisters the token server-side and natively when turned off', async () => {
    const { disablePush, enablePush, pushState } = await import('./push');
    getNativePushToken.mockResolvedValue({ granted: true, token: 'device-token-1' });
    await enablePush();

    await disablePush();
    expect(pushUnregisterDevice).toHaveBeenCalledWith('device-token-1');
    expect(clearNativePushToken).toHaveBeenCalled();
    expect(pushState()).toBe('default');
  });

  it('re-registers a rotated token on boot, retiring the old one', async () => {
    const { enablePush, refreshNativePushRegistration } = await import('./push');
    getNativePushToken.mockResolvedValue({ granted: true, token: 'device-token-1' });
    await enablePush();
    vi.clearAllMocks();

    // FCM rotated the token while the app was closed — nothing told the app, which is
    // why the boot re-registration exists at all.
    getNativePushToken.mockResolvedValue({ granted: true, token: 'device-token-2' });
    await refreshNativePushRegistration();

    expect(pushUnregisterDevice).toHaveBeenCalledWith('device-token-1');
    expect(pushRegisterDevice).toHaveBeenCalledWith('device-token-2');
  });

  it('does not re-register on boot when notifications are off on this device', async () => {
    const { refreshNativePushRegistration } = await import('./push');
    await refreshNativePushRegistration();
    expect(getNativePushToken).not.toHaveBeenCalled();
    expect(pushRegisterDevice).not.toHaveBeenCalled();
  });
});
