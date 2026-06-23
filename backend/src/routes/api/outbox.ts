/**
 * Outbox routes: list queued sends (Scheduled/Outbox view) and cancel a pending action.
 * Cancel is the server-owned UNDO for send, delete, and archive — it races the runner via an
 * atomic flip (see cancelOutbox), so the response distinguishes a real cancel from "too late".
 */
import type { FastifyInstance } from 'fastify';
import { cancelOutbox, listPendingSends, nudgeOutbox } from '../../outbox/runner.js';

export async function outboxRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/outbox', async () => {
    return { entries: listPendingSends() };
  });

  app.delete<{ Params: { id: string } }>('/api/outbox/:id', async (req, reply) => {
    const outcome = cancelOutbox(req.params.id);
    if (outcome === 'not-found') return reply.code(404).send({ error: 'unknown outbox entry' });
    if (outcome === 'too-late') {
      // The runner already claimed it (sending/sent) — the action has committed.
      return reply.code(409).send({ error: 'already committed', canceled: false });
    }
    // A canceled delete/archive emitted mail:restored; nudge in case other due work is waiting.
    nudgeOutbox();
    return { canceled: true };
  });
}
