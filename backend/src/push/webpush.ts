/**
 * Web Push (VAPID) for background notifications. PWAs are suspended when
 * backgrounded, so Socket.io alone can't wake them — Web Push can (ARCHITECTURE §3).
 * Disabled gracefully when VAPID keys aren't configured.
 */
import webpush from 'web-push';
import { env } from '../env.js';
import { createLogger } from '../logger.js';
import { deletePushSubscription, getMessage, listPushSubscriptions } from '../db/queries.js';
import { onSignal } from '../events.js';
import { notificationFor, type MailNotification } from './payload.js';

const log = createLogger('push');
let enabled = false;

/** Configure VAPID. Returns true if Web Push is active. */
export function initWebPush(): boolean {
  const vapid = env.vapid();
  if (!vapid) {
    log.warn('VAPID keys not set — Web Push disabled');
    return false;
  }
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  enabled = true;
  return true;
}

export function vapidPublicKey(): string | null {
  return env.vapid()?.publicKey ?? null;
}

async function broadcast(payload: MailNotification): Promise<void> {
  if (!enabled) return;
  const subs = listPushSubscriptions();
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload),
        );
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        // 404/410 mean the subscription is dead — prune it.
        if (status === 404 || status === 410) deletePushSubscription(s.endpoint);
        else log.warn('push send failed:', (err as Error).message);
      }
    }),
  );
}

/**
 * Subscribe to the event bus and fire background notifications (ARCHITECTURE §3).
 *
 * Only the installed PWA is reached from here: it holds a VAPID subscription, and
 * `mail:new` fans out to it. The Android APK cannot (System WebView exposes no Push API);
 * it polls `GET /api/push/pending` from an alarm instead (push/pending.ts), so it needs no
 * trigger. Both see INBOX arrivals only — `mail:new` is emitted for the INBOX alone, and
 * the pending query reads the INBOX — so neither notifies about a Sent copy, a saved draft,
 * or a backfill sweep (ARCHITECTURE §9).
 */
export function wirePushNotifications(): void {
  onSignal((signal) => {
    if (signal.type === 'mail:new') {
      const m = getMessage(signal.messageId);
      if (!m) return;
      const payload = notificationFor(m);
      void broadcast(payload);
      return;
    }
  });
}
