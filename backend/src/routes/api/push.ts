/**
 * Web Push (VAPID) subscription management — the background-notification channel for
 * a suspended PWA (ARCHITECTURE §3). The public key bootstraps the client subscription.
 */
import type { FastifyInstance } from 'fastify';
import type { PushSubscriptionDto } from '@maily/shared';
import { deletePushSubscription, savePushSubscription } from '../../db/queries.js';
import { vapidPublicKey } from '../../push/webpush.js';

export async function pushRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/push/key', async () => ({ publicKey: vapidPublicKey() }));

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
}
