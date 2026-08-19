/**
 * The Android APK's push stream — deliberately registered on the root context, outside
 * the JWT-gated `apiRoutes` plugin, because it authenticates differently from everything
 * else in Maily.
 *
 * Two reasons it cannot live behind the normal gate:
 *
 * - The connection is made by the APK's *foreground service*, not the WebView, so it has
 *   no app session to ride on. It presents a device secret minted for it instead
 *   (push/devices.ts).
 * - This deployment runs `MAILY_DISABLE_AUTH=true` behind an SSO gateway, so the normal
 *   gate is a no-op and no JWT is ever minted. A device credential must therefore be
 *   checked *here*, unconditionally — this route never inherits the bypass, whatever the
 *   rest of the API is configured to do. That also makes it safe to punch through the
 *   gateway for this one path, which is required: an SSO redirect is not something a
 *   background service can follow.
 */
import type { FastifyInstance } from 'fastify';
import { deviceForAuthHeader } from '../push/devices.js';
import { attachDeviceStream } from '../push/stream.js';

export async function pushStreamRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/push/stream', async (req, reply) => {
    const device = deviceForAuthHeader(req.headers.authorization);
    if (!device) {
      // 401 with no challenge: a browser landing here should not be prompted for
      // credentials, and the shell distinguishes "revoked" from "unreachable" by status.
      return reply.code(401).send({ error: 'unauthorized' });
    }
    attachDeviceStream(device, req, reply);
  });
}
