/**
 * The Android APK cannot use Web Push: System WebView exposes no `PushManager`, so the
 * subscription flow the PWA uses reports "unsupported" and the notifications toggle
 * would be permanently unavailable. On native the same toggle drives maily's own
 * background check instead — the server mints a device secret, and the shell stores it
 * and presents it every time it asks what has arrived.
 *
 * What is pinned here is the credential's lifecycle, because every failure mode is
 * invisible: a secret minted for a shell that never armed its check leaves an orphan
 * server row, and a shell that lost its secret leaves the toggle claiming notifications
 * are on when nothing is asking.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pushKey = vi.fn(() => Promise.resolve({ publicKey: 'vapid' }));
const pushRegisterDevice = vi.fn(() => Promise.resolve({ token: 'device-secret-1' }));
const pushUnregisterDevice = vi.fn(() => Promise.resolve({ ok: true }));

vi.mock('./client', () => ({
  api: { pushKey, pushRegisterDevice, pushUnregisterDevice },
}));

const enableNativePush = vi.fn();
const disableNativePush = vi.fn(() => Promise.resolve<string | null>(null));
const nativePushStatus = vi.fn();
let native = true;

vi.mock('../nativeAndroid', () => ({
  isNativeAndroid: () => native,
  enableNativePush,
  disableNativePush,
  nativePushStatus,
}));

const ON = { enabled: true, granted: true };

describe('background notifications in the Android APK', () => {
  beforeEach(() => {
    native = true;
    localStorage.clear();
    vi.clearAllMocks();
    pushRegisterDevice.mockResolvedValue({ token: 'device-secret-1' });
    disableNativePush.mockResolvedValue(null);
  });

  it('hands a minted secret to the shell instead of reporting the WebView unsupported', async () => {
    const { enablePush, pushState } = await import('./push');
    expect(pushState()).toBe('default');

    enableNativePush.mockResolvedValue(ON);
    await expect(enablePush()).resolves.toEqual({ ok: true });

    expect(enableNativePush).toHaveBeenCalledWith('device-secret-1');
    expect(pushUnregisterDevice).not.toHaveBeenCalled();
    expect(pushState()).toBe('granted');
  });

  it('revokes the secret when the shell declines, leaving no orphan registration', async () => {
    const { enablePush, pushState } = await import('./push');
    enableNativePush.mockResolvedValue({ enabled: false, granted: false });

    const result = await enablePush();
    expect(result.ok).toBe(false);
    expect(result).toHaveProperty('reason');
    // The server would otherwise keep a row it notifies into a socket nobody opens.
    expect(pushUnregisterDevice).toHaveBeenCalledWith('device-secret-1');
    expect(pushState()).toBe('default');
  });

  it('explains an APK too old to have the push methods', async () => {
    const { enablePush } = await import('./push');
    enableNativePush.mockResolvedValue(null);

    const result = await enablePush();
    expect(result.ok).toBe(false);
    expect(pushUnregisterDevice).toHaveBeenCalledWith('device-secret-1');
  });

  it('revokes the shell-held secret server-side when turned off', async () => {
    const { disablePush, enablePush, pushState } = await import('./push');
    enableNativePush.mockResolvedValue(ON);
    await enablePush();

    disableNativePush.mockResolvedValue('device-secret-1');
    await disablePush();
    expect(pushUnregisterDevice).toHaveBeenCalledWith('device-secret-1');
    expect(pushState()).toBe('default');
  });

  it('re-issues a secret when the shell lost the one it had', async () => {
    const { enablePush, resumeNativePush, pushState } = await import('./push');
    enableNativePush.mockResolvedValue(ON);
    await enablePush();
    vi.clearAllMocks();

    // App storage cleared: the service has nothing to connect with, and nothing told
    // the web layer — which is why the reconcile exists at all.
    nativePushStatus.mockResolvedValue({ enabled: false, granted: true });
    pushRegisterDevice.mockResolvedValue({ token: 'device-secret-2' });
    enableNativePush.mockResolvedValue(ON);
    await resumeNativePush();

    expect(enableNativePush).toHaveBeenCalledWith('device-secret-2');
    expect(pushState()).toBe('granted');
  });

  it('stops claiming notifications are on when the shell refuses to run the service', async () => {
    const { enablePush, resumeNativePush, pushState } = await import('./push');
    enableNativePush.mockResolvedValue(ON);
    await enablePush();
    vi.clearAllMocks();

    // Permission revoked in Android settings while the app was closed.
    nativePushStatus.mockResolvedValue({ enabled: false, granted: false });
    pushRegisterDevice.mockResolvedValue({ token: 'device-secret-2' });
    enableNativePush.mockResolvedValue({ enabled: false, granted: false });
    await resumeNativePush();

    expect(pushUnregisterDevice).toHaveBeenCalledWith('device-secret-2');
    expect(pushState()).toBe('default');
  });

  it('adopts a running service the web layer had forgotten about', async () => {
    const { resumeNativePush, pushState } = await import('./push');
    nativePushStatus.mockResolvedValue(ON);

    await resumeNativePush();
    expect(pushRegisterDevice).not.toHaveBeenCalled();
    expect(pushState()).toBe('granted');
  });

  it('does nothing on boot when notifications are off on this device', async () => {
    const { resumeNativePush } = await import('./push');
    nativePushStatus.mockResolvedValue({ enabled: false, granted: false });

    await resumeNativePush();
    expect(pushRegisterDevice).not.toHaveBeenCalled();
    expect(enableNativePush).not.toHaveBeenCalled();
  });
});
