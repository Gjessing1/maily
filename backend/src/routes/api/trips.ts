/**
 * Trip History API (ROADMAP Phase 4). A read-only travel timeline over the `travel`
 * enricher's `derived`-stage output — flights/stays/events grouped into trips,
 * newest-first, each deep-linking to its source message by internal UUID. Pure
 * retrieval (no proposals, no side effects); the heavy extraction already ran in the
 * pipeline worker, so this is just a grouped read.
 */
import type { FastifyInstance } from 'fastify';
import { listTrips } from '../../pipeline/trips.js';

export async function tripRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/trips', async () => listTrips());
}
