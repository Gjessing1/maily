/**
 * Web Push subscription flow (ARCHITECTURE §3). Background notifications need an
 * installed PWA on iOS; the permission prompt must be user-initiated. We register
 * the browser's PushSubscription with the backend, which fans out via VAPID.
 */
import { api } from './client';

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

export type PushState = 'unsupported' | 'denied' | 'granted' | 'default';

export function pushState(): PushState {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';
  return Notification.permission as PushState;
}

/**
 * Request permission and subscribe. Must be called from a user gesture.
 * Returns true on success. Safe to call when already subscribed (idempotent).
 */
export async function enablePush(): Promise<boolean> {
  if (pushState() === 'unsupported') return false;

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return false;

  const { publicKey } = await api.pushKey();
  if (!publicKey) return false; // VAPID not configured server-side.

  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const sub =
    existing ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));

  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return false;
  await api.pushSubscribe({
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  });
  return true;
}

export async function disablePush(): Promise<void> {
  if (pushState() === 'unsupported') return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  await api.pushUnsubscribe(sub.endpoint).catch(() => undefined);
  await sub.unsubscribe();
}
