/**
 * Action Center API — the `derived`-stage proposals an enricher surfaced as *offers*
 * (ROADMAP Phase 4). Heavy work (extraction) already ran in the pipeline worker; this
 * is just the human-in-the-loop read + approve/dismiss surface. Deep links use the
 * internal message UUID (never Message-ID/UID). Approve runs the proposal type's
 * registered side-effect handler if one exists (`proposal-handlers.ts`); types with no
 * handler (e.g. `calendar_event` when CalDAV is unconfigured) are still approvable —
 * the offer is acknowledged with no external effect.
 */
import type { FastifyInstance } from 'fastify';
import type { ProposalActionResult } from '@maily/shared';
import {
  approveProposal,
  dismissProposal,
  getProposal,
  listPendingProposals,
  pendingProposalCount,
  proposalsForMessage,
} from '../../pipeline/proposals.js';
import { approveHandlerFor } from '../../pipeline/proposal-handlers.js';

function parsePayload(json: string | null): unknown {
  if (json == null) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export async function actionRoutes(app: FastifyInstance): Promise<void> {
  // The hub list: every live offer, newest-first, with source-message context.
  app.get('/api/actions', async () => listPendingProposals());

  // Lightweight count for the nav badge (avoids shipping the whole list).
  app.get('/api/actions/count', async () => ({ count: pendingProposalCount() }));

  // Offers for one message — drives the inline action chip in the reader.
  app.get<{ Params: { id: string } }>('/api/messages/:id/actions', async (req) =>
    proposalsForMessage(req.params.id),
  );

  // Approve → run the type's side-effect handler (if any), then mark approved.
  app.post<{ Params: { id: string } }>('/api/actions/:id/approve', async (req, reply) => {
    const row = getProposal(req.params.id);
    if (!row) return reply.code(404).send({ error: 'not found' });
    if (row.status !== 'pending') return reply.code(409).send({ error: 'already resolved' });

    const handler = approveHandlerFor(row.type);
    let handled = false;
    if (handler) {
      try {
        await handler({
          id: row.id,
          messageId: row.messageId,
          type: row.type,
          title: row.title,
          payload: parsePayload(row.payload),
        });
        handled = true;
      } catch (err) {
        // The user's decision is sound; only the side effect failed. Surface it and
        // leave the proposal pending so it can be retried rather than silently lost.
        app.log.warn(`approve handler for ${row.type} failed: ${(err as Error).message}`);
        return reply.code(502).send({ error: 'action failed' });
      }
    }

    approveProposal(row.id);
    const result: ProposalActionResult = { ok: true, status: 'approved', handled };
    return result;
  });

  // Dismiss → mark dismissed (no side effect). Idempotent.
  app.post<{ Params: { id: string } }>('/api/actions/:id/dismiss', async (req, reply) => {
    const row = getProposal(req.params.id);
    if (!row) return reply.code(404).send({ error: 'not found' });
    if (row.status !== 'pending') return reply.code(409).send({ error: 'already resolved' });

    dismissProposal(row.id);
    const result: ProposalActionResult = { ok: true, status: 'dismissed', handled: false };
    return result;
  });
}
