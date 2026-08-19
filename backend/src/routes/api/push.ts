/**
 * Background-notification registration (ARCHITECTURE §3), one route pair per transport:
 *
 * - **Web Push (VAPID)** for the installed PWA — the public key bootstraps the
 *   browser's own `PushSubscription`.
 * - **Device registration** for the Android APK, which is a WebView shell and therefore
 *   has no Push API to subscribe with. It gets a minted device secret, which its
 *   foreground service presents on `GET /api/push/stream` (routes/pushStream.ts).
 *
 * `GET /api/push/key` reports both channels so the client can offer the one it can
 * actually use; a channel with no server-side credentials reports itself unavailable
 * rather than letting the user enable something that will never deliver.
 *
 * These routes are inside the authenticated API on purpose: minting a device credential
 * is exactly the privileged act that must ride an existing session. Only the *stream* is
 * registered outside it, where the minted secret is the credential.
 */
import type { FastifyInstance } from 'fastify';
import type { PushSubscriptionDto } from '@maily/shared';
import { deletePushSubscription, savePushSubscription } from '../../db/queries.js';
import { vapidPublicKey } from '../../push/webpush.js';
import { issueDeviceToken, revokeDeviceToken } from '../../push/devices.js';
import { connectedDeviceCount } from '../../push/stream.js';

/** Device secrets are 32 bytes base64url; bound the input so a bad client can't stuff a row. */
const MAX_TOKEN_LENGTH = 512;

export async function pushRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/push/key', async () => ({
    publicKey: vapidPublicKey(),
    // Self-hosted, so unlike the old Firebase channel there is nothing to configure and
    // nothing that can be missing — the stream is available wherever Maily is.
    stream: true,
    connectedDevices: connectedDeviceCount(),
  }));

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

  // Mint a credential for this device. The plaintext is returned once and never stored,
  // so re-enabling notifications issues a *new* secret rather than recovering the old
  // one — which is the right shape: the shell keeps it, and losing it is a re-enable.
  app.post<{ Body: { platform?: string } }>('/api/push/device', async (req) => ({
    token: issueDeviceToken(req.body?.platform === 'ios' ? 'ios' : 'android'),
  }));

  app.post<{ Body: { token?: string } }>('/api/push/device/unregister', async (req) => {
    const token = req.body?.token?.trim();
    if (token && token.length <= MAX_TOKEN_LENGTH) revokeDeviceToken(token);
    return { ok: true };
  });
}
