/**
 * Public auth route: exchange the master password for a JWT. This is the only
 * unauthenticated endpoint.
 */
import type { FastifyInstance } from 'fastify';
import { env } from '../env.js';
import { issueToken, verifyMasterPassword } from '../http/auth.js';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Public: lets the PWA decide whether to show the login screen. When auth is
  // disabled (external SSO), the frontend skips login and sends no token.
  app.get('/api/auth/config', async () => ({ authRequired: !env.disableAuth }));

  // Document-navigation entry point the PWA uses when an external auth gateway
  // (tinyauth/Caddy) has expired the session. The app shell is served from the
  // service-worker cache, so a plain reload never reaches the gateway to be
  // redirected to its login. Navigating the *document* here works because the SW
  // denylists /api (so it hits the network) and the gateway guards it: logged out,
  // tinyauth intercepts and shows its login, then bounces back here, and we send
  // the browser home to the now-authed app. When auth isn't gateway-fronted this is
  // simply an unreachable code path (the frontend never navigates here).
  app.get('/api/auth/relogin', async (_req, reply) => reply.redirect('/'));

  app.post<{ Body: { password?: string } }>('/api/auth/login', async (req, reply) => {
    const password = req.body?.password;
    if (!password || !verifyMasterPassword(password)) {
      return reply.code(401).send({ error: 'invalid password' });
    }
    return { token: issueToken(app) };
  });
}
