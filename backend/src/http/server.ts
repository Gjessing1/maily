/**
 * Fastify app factory. Registers CORS, JWT, the public auth route and the
 * protected API plugin. Socket.io is attached separately (see sockets/) once the
 * underlying HTTP server is listening.
 */
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import Fastify, { type FastifyInstance } from 'fastify';
import { env } from '../env.js';
import { authRoutes } from '../routes/auth.js';
import { apiRoutes } from '../routes/api.js';
import { staticSite } from './static.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    // Allow reasonably large JSON bodies (composed mail with inline content).
    bodyLimit: 30 * 1024 * 1024,
  });

  await app.register(cors, { origin: true });
  await app.register(jwt, { secret: env.jwtSecret() });

  await app.register(authRoutes);
  await app.register(apiRoutes);
  // Last, and on the root context (not encapsulated) so reply.sendFile and the
  // SPA not-found handler apply app-wide: serves the built PWA in production
  // (no-op in dev, where Vite serves the app and proxies the API).
  await staticSite(app);

  return app;
}
