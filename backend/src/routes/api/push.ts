/**
 * Background-notification registration (ARCHITECTURE §3), one route pair per transport:
 *
 * - **Web Push (VAPID)** for the installed PWA — the public key bootstraps the
 *   browser's own `PushSubscription`.
 * - **FCM device tokens** for the Android APK, which is a WebView shell and therefore
 *   has no Push API to subscribe with. It registers a Firebase token instead.
 *
 * `GET /api/push/key` reports both channels so the client can offer the one it can
 * actually use; a channel with no server-side credentials reports itself unavailable
 * rather than letting the user enable something that will never deliver.
 */
import type { FastifyInstance } from 'fastify';
import type { PushSubscriptionDto } from '@maily/shared';
import {
  deleteDeviceToken,
  deletePushSubscription,
  saveDeviceToken,
  savePushSubscription,
} from '../../db/queries.js';
import { vapidPublicKey } from '../../push/webpush.js';
import { fcmEnabled } from '../../push/fcm.js';

/** Registration tokens are opaque; bound the length so a bad client can't stuff the table. */
const MAX_TOKEN_LENGTH = 4096;

export async function pushRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/push/key', async () => ({ publicKey: vapidPublicKey(), fcm: fcmEnabled() }));

  app.post<{ Body: PushSubscriptionDto }>('/api/push/subscribe', async (req, reply) => {
    const sub = req.body;
    if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
      return reply.code(400).send({ error: 'invalid subscription' });
    }
    savePushSubscription(sub.endpoint, sub.keys.p256dh, sub.keys.auth);
    return { ok: true };
  });

  app.post<{ Body: { endpoint?: string } }>('/api/push/unsubscribe', async (req) => {
    if (req.body?.endpoint) deletePushSubscription(req.body.endpoint);
    return { ok: true };
  });

  // Register (or refresh) the APK's FCM token. The APK calls this on every boot: FCM
  // rotates tokens silently and the remote-origin WebView has no working plugin listener
  // to be told about it, so re-registering is how a rotation is noticed at all.
  app.post<{ Body: { token?: string; platform?: string } }>(
    '/api/push/device',
    async (req, reply) => {
      const token = req.body?.token?.trim();
      if (!token || token.length > MAX_TOKEN_LENGTH) {
        return reply.code(400).send({ error: 'invalid token' });
      }
      if (!fcmEnabled()) return reply.code(503).send({ error: 'FCM is not configured' });
      saveDeviceToken(token, req.body?.platform === 'ios' ? 'ios' : 'android');
      return { ok: true };
    },
  );

  app.post<{ Body: { token?: string } }>('/api/push/device/unregister', async (req) => {
    if (req.body?.token) deleteDeviceToken(req.body.token);
    return { ok: true };
  });
}
