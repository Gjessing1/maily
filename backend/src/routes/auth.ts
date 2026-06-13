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

  app.post<{ Body: { password?: string } }>('/api/auth/login', async (req, reply) => {
    const password = req.body?.password;
    if (!password || !verifyMasterPassword(password)) {
      return reply.code(401).send({ error: 'invalid password' });
    }
    return { token: issueToken(app) };
  });
}
