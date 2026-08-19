/**
 * Background-notification opt-in (ARCHITECTURE §3), across the two transports maily
 * actually runs on:
 *
 * - **Browser / installed PWA → Web Push (VAPID).** The permission prompt must come
 *   from a user gesture, and on iOS the PWA must be installed to the Home Screen first.
 * - **Android APK → FCM.** The APK is a WebView shell, and Android System WebView
 *   exposes no Push API at all (`PushManager` is simply absent), so there is no
 *   subscription to make. The native shell registers with Firebase and hands back a
 *   device token, which we register with the backend over this authenticated session.
 *
 * Both end up in the same place: a row the server fans `mail:new` out to.
 */
import { api } from './client';
import { clearNativePushToken, getNativePushToken, isNativeAndroid } from '../nativeAndroid';

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

export type PushState = 'unsupported' | 'denied' | 'granted' | 'default';

/** Outcome of an enable attempt — `reason` is shown to the user when it didn't take. */
export type PushEnableResult = { ok: true } | { ok: false; reason?: string };

/**
 * The FCM token this device last registered. Android has no synchronous permission
 * query to drive the toggle from, and re-asking Firebase is async, so the fact that we
 * hold a token IS the "notifications are on here" state. Survives reloads; cleared on
 * disable.
 */
const DEVICE_TOKEN_KEY = 'maily.push.deviceToken';

function storedDeviceToken(): string | null {
  try {
    return localStorage.getItem(DEVICE_TOKEN_KEY);
  } catch {
    return null;
  }
}

function rememberDeviceToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(DEVICE_TOKEN_KEY, token);
    else localStorage.removeItem(DEVICE_TOKEN_KEY);
  } catch {
    // Private mode / storage disabled — the registration still works, it just won't
    // be remembered across reloads.
  }
}

export function pushState(): PushState {
  if (isNativeAndroid()) return storedDeviceToken() ? 'granted' : 'default';
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';
  return Notification.permission as PushState;
}

/** Register the APK's Firebase token with the backend. */
async function enableNativePush(): Promise<PushEnableResult> {
  const { fcm } = await api.pushKey();
  if (!fcm) {
    return { ok: false, reason: 'This server has no Firebase credentials configured.' };
  }
  const result = await getNativePushToken();
  if (!result) {
    return { ok: false, reason: 'This app version cannot register for notifications.' };
  }
  if (!result.granted) {
    return { ok: false, reason: 'Notification permission was declined.' };
  }
  if (!result.token) {
    return { ok: false, reason: 'Firebase did not return a token for this device.' };
  }
  await api.pushRegisterDevice(result.token);
  rememberDeviceToken(result.token);
  return { ok: true };
}

/**
 * Request permission and subscribe. Must be called from a user gesture.
 * Safe to call when already subscribed (idempotent).
 */
export async function enablePush(): Promise<PushEnableResult> {
  if (isNativeAndroid()) return enableNativePush();
  if (pushState() === 'unsupported') return { ok: false };

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false };

  const { publicKey } = await api.pushKey();
  if (!publicKey) {
    return { ok: false, reason: 'This server has no VAPID keys configured.' };
  }

  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const sub =
    existing ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));

  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return { ok: false };
  await api.pushSubscribe({
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  });
  return { ok: true };
}

export async function disablePush(): Promise<void> {
  if (isNativeAndroid()) {
    const token = storedDeviceToken();
    rememberDeviceToken(null);
    if (token) await api.pushUnregisterDevice(token).catch(() => undefined);
    await clearNativePushToken();
    return;
  }
  if (pushState() === 'unsupported') return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  await api.pushUnsubscribe(sub.endpoint).catch(() => undefined);
  await sub.unsubscribe();
}

/**
 * Re-register this device's FCM token on boot. Firebase rotates tokens silently, and
 * the remote-origin WebView has no working plugin listener to be told when it happens
 * (see nativeAndroid.getNativePushToken), so asking again each time the app opens is
 * how a rotation is ever noticed. A no-op unless notifications are already on here.
 */
export async function refreshNativePushRegistration(): Promise<void> {
  if (!isNativeAndroid()) return;
  const previous = storedDeviceToken();
  if (!previous) return; // Notifications are off on this device — nothing to keep alive.
  try {
    const result = await getNativePushToken();
    if (!result?.granted || !result.token) return; // Permission revoked in Android settings.
    if (result.token !== previous) {
      await api.pushUnregisterDevice(previous).catch(() => undefined);
    }
    await api.pushRegisterDevice(result.token);
    rememberDeviceToken(result.token);
  } catch {
    // Offline, or the server is briefly unreachable — the next boot retries.
  }
}
