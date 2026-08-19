/**
 * Background-notification opt-in (ARCHITECTURE §3), across the two transports maily
 * actually runs on:
 *
 * - **Browser / installed PWA → Web Push (VAPID).** The permission prompt must come
 *   from a user gesture, and on iOS the PWA must be installed to the Home Screen first.
 * - **Android APK → maily's own push stream.** The APK is a WebView shell, and Android
 *   System WebView exposes no Push API at all (`PushManager` is simply absent), so there
 *   is no subscription to make. The native shell runs a foreground service holding an SSE
 *   connection to the maily server instead, and posts Android notifications itself.
 *
 * Both end up in the same place: a row the server fans `mail:new` out to. Neither
 * involves a third party — the PWA's push goes through the browser vendor's endpoint
 * because that is what Web Push is, and the APK's goes nowhere but maily.
 *
 * The device secret lives on the native side only. The web layer keeps a boolean, which
 * is all the toggle needs and is not a credential worth protecting.
 */
import { api } from './client';
import {
  disableNativePush,
  enableNativePush,
  isNativeAndroid,
  nativePushStatus,
} from '../nativeAndroid';

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
 * Whether notifications are on in this APK. Android has no synchronous permission query
 * and the authoritative answer lives across the bridge (a promise), so the toggle renders
 * from this cached marker and `resumeNativePush` reconciles it against the shell on boot.
 */
const NATIVE_ENABLED_KEY = 'maily.push.native';

function nativeEnabled(): boolean {
  try {
    return localStorage.getItem(NATIVE_ENABLED_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberNativeEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(NATIVE_ENABLED_KEY, '1');
    else localStorage.removeItem(NATIVE_ENABLED_KEY);
  } catch {
    // Private mode / storage disabled — the service still runs, the toggle just
    // renders from the shell's answer one tick later instead.
  }
}

export function pushState(): PushState {
  if (isNativeAndroid()) return nativeEnabled() ? 'granted' : 'default';
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';
  return Notification.permission as PushState;
}

/**
 * Mint a device credential and hand it to the shell, which stores it and starts its
 * foreground service. A credential that fails to take hold is revoked immediately rather
 * than left as an orphan row the server would keep trying to notify.
 */
async function enableNativePushHere(): Promise<PushEnableResult> {
  const { token } = await api.pushRegisterDevice();
  const status = await enableNativePush(token);
  if (!status || !status.enabled) {
    await api.pushUnregisterDevice(token).catch(() => undefined);
    return {
      ok: false,
      reason: status
        ? 'The app could not start its notification service.'
        : 'This app version cannot register for notifications. Update the app first.',
    };
  }
  if (!status.granted) {
    await api.pushUnregisterDevice(token).catch(() => undefined);
    await disableNativePush();
    return { ok: false, reason: 'Notification permission was declined.' };
  }
  rememberNativeEnabled(true);
  return { ok: true };
}

/**
 * Request permission and subscribe. Must be called from a user gesture.
 * Safe to call when already subscribed (idempotent).
 */
export async function enablePush(): Promise<PushEnableResult> {
  if (isNativeAndroid()) return enableNativePushHere();
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
    rememberNativeEnabled(false);
    // The shell hands back the secret it dropped, which is the only copy — revoke the
    // matching row so a stale credential can never reconnect.
    const token = await disableNativePush();
    if (token) await api.pushUnregisterDevice(token).catch(() => undefined);
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
 * Reconcile the toggle with what the shell actually holds, on app open.
 *
 * The two can drift, and both directions are real: clearing app storage wipes the
 * shell's credential while the web marker survives in the WebView's own storage, and
 * reinstalling the web app's storage (or a fresh SSO session) loses the marker while the
 * service keeps running. Nothing here is user-visible unless it has to be — a shell that
 * lost its credential is silently re-issued one, since the user already asked for
 * notifications and Android does not re-prompt for a permission already granted.
 */
export async function resumeNativePush(): Promise<void> {
  if (!isNativeAndroid()) return;
  const status = await nativePushStatus();
  if (!status) return; // An APK older than the web app; nothing to reconcile against.

  if (status.enabled) {
    rememberNativeEnabled(true);
    return;
  }
  if (!nativeEnabled()) return; // Off here, and the shell agrees.

  try {
    const { token } = await api.pushRegisterDevice();
    const restored = await enableNativePush(token);
    if (restored?.enabled) return;
    await api.pushUnregisterDevice(token).catch(() => undefined);
  } catch {
    // Offline, or the server is briefly unreachable — the next app open retries.
    return;
  }
  // The shell refuses to run it (permission revoked in Android settings, most likely),
  // so stop claiming it is on.
  rememberNativeEnabled(false);
}
