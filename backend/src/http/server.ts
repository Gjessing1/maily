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

  return app;
}
