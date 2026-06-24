/**
 * Detach-to-local routes: preview (dry-run), run, and status for the job that deletes
 * mail from the provider while keeping the full local copy (see `detach/job.ts`). The
 * destructive run is gated behind an explicit POST after the user has seen a dry-run.
 */
import type { FastifyInstance } from 'fastify';
import type { DetachRequest } from '@maily/shared';
import { DetachError, detachStatus, previewDetach, startDetach } from '../../detach/job.js';

/** Validate the request body shape shared by dry-run and run. */
function parseRequest(body: unknown): DetachRequest | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.accountId !== 'string') return null;
  if (b.scope !== 'all' && b.scope !== 'cutoff' && b.scope !== 'range') return null;
  if (b.scope === 'cutoff' && typeof b.cutoffMs !== 'number') return null;
  if (b.scope === 'range' && typeof b.fromMs !== 'number' && typeof b.toMs !== 'number')
    return null;
  return {
    accountId: b.accountId,
    scope: b.scope,
    cutoffMs: typeof b.cutoffMs === 'number' ? b.cutoffMs : undefined,
    fromMs: typeof b.fromMs === 'number' ? b.fromMs : undefined,
    toMs: typeof b.toMs === 'number' ? b.toMs : undefined,
  };
}

export async function detachRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/detach/status', async () => detachStatus());

  app.post<{ Body: unknown }>('/api/detach/dry-run', async (req, reply) => {
    const parsed = parseRequest(req.body);
    if (!parsed) return reply.code(400).send({ error: 'invalid detach request' });
    return previewDetach(parsed);
  });

  app.post<{ Body: unknown }>('/api/detach/run', async (req, reply) => {
    const parsed = parseRequest(req.body);
    if (!parsed) return reply.code(400).send({ error: 'invalid detach request' });
    try {
      return startDetach(parsed);
    } catch (err) {
      if (err instanceof DetachError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });
}
