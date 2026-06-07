/**
 * Protected HTTP API aggregator. Everything here requires a valid JWT (the onRequest
 * hook below, inherited by every sub-plugin registered in this context). Heavy payloads
 * (bodies, attachment bytes) go over HTTP — never sockets (ARCHITECTURE §3).
 *
 * The surface is split by resource so each module stays small and single-purpose;
 * this file only wires the auth gate and registers them.
 */
import type { FastifyInstance } from 'fastify';
import { authenticate } from '../http/auth.js';
import { settingsRoutes } from './api/settings.js';
import { accountRoutes } from './api/accounts.js';
import { messageRoutes } from './api/messages.js';
import { messageActionRoutes } from './api/message-actions.js';
import { attachmentRoutes } from './api/attachments.js';
import { composeRoutes } from './api/compose.js';
import { contactRoutes } from './api/contacts.js';
import { pushRoutes } from './api/push.js';
import { actionRoutes } from './api/actions.js';
import { cleanupRoutes } from './api/cleanup.js';

export async function apiRoutes(app: FastifyInstance): Promise<void> {
  // Gate the whole encapsulated plugin behind JWT auth. Registered before the child
  // plugins so they all inherit it (Fastify hooks cascade to descendant contexts).
  app.addHook('onRequest', authenticate);

  await app.register(settingsRoutes);
  await app.register(accountRoutes);
  await app.register(messageRoutes);
  await app.register(messageActionRoutes);
  await app.register(attachmentRoutes);
  await app.register(composeRoutes);
  await app.register(contactRoutes);
  await app.register(pushRoutes);
  await app.register(actionRoutes);
  await app.register(cleanupRoutes);
}
