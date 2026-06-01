/**
 * Public auth route: exchange the master password for a JWT. This is the only
 * unauthenticated endpoint.
 */
import type { FastifyInstance } from 'fastify';
import { issueToken, verifyMasterPassword } from '../http/auth.js';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { password?: string } }>('/api/auth/login', async (req, reply) => {
    const password = req.body?.password;
    if (!password || !verifyMasterPassword(password)) {
      return reply.code(401).send({ error: 'invalid password' });
    }
    return { token: issueToken(app) };
  });
}
