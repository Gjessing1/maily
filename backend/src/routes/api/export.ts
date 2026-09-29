/**
 * Read-only export feeds for other apps on the host. `GET /api/export/billing` hands
 * Moneta every invoice and receipt, paged by a cursor that only moves forward; the
 * document bytes come from the normal attachment route.
 */
import type { FastifyInstance } from 'fastify';
import {
  billingExportPage,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  parseCursor,
} from '../../pipeline/billing-export.js';

export async function exportRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { after?: string; limit?: string } }>(
    '/api/export/billing',
    async (req, reply) => {
      const after = req.query.after?.trim() || null;
      if (after && !parseCursor(after)) {
        return reply.code(400).send({ error: 'invalid cursor' });
      }
      const requested = Number(req.query.limit ?? DEFAULT_LIMIT);
      let limit = DEFAULT_LIMIT;
      if (Number.isInteger(requested) && requested > 0) limit = Math.min(requested, MAX_LIMIT);
      return billingExportPage({ after, limit });
    },
  );
}
