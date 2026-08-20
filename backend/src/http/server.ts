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
import { appReleaseRoutes } from '../routes/appRelease.js';
import { pushDeviceRoutes } from '../routes/pushDevice.js';
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
  // Public so the first APK can be installed before Maily has an app session.
  // An upstream TinyAuth deployment may still apply its own access policy.
  await app.register(appReleaseRoutes);
  // Outside apiRoutes: the APK's background poll authenticates with its own device
  // secret, not the app session, and must be checked even under MAILY_DISABLE_AUTH.
  await app.register(pushDeviceRoutes);
  await app.register(apiRoutes);
  // Last, and on the root context (not encapsulated) so reply.sendFile and the
  // SPA not-found handler apply app-wide: serves the built PWA in production
  // (no-op in dev, where Vite serves the app and proxies the API).
  await staticSite(app);

  return app;
}
