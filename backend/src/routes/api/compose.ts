/**
 * Outbound: send (SMTP, then provider-aware Sent handling — ARCHITECTURE §10) and
 * save-draft (APPEND to \Drafts, no SMTP). Both resolve the account via its engine.
 */
import type { FastifyInstance } from 'fastify';
import type { SaveDraftRequest, SendMessageRequest } from '@maily/shared';
import { getEngine } from '../../imap/registry.js';
import { sendMessage } from '../../mail/send.js';
import { saveDraft } from '../../mail/draft.js';

export async function composeRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string }; Body: SendMessageRequest }>(
    '/api/accounts/:id/send',
    async (req, reply) => {
      const engine = getEngine(req.params.id);
      if (!engine) return reply.code(404).send({ error: 'unknown account' });
      if (!req.body?.to?.length) return reply.code(400).send({ error: 'recipient required' });
      const result = await sendMessage(engine.accountConfig, req.body);
      return result;
    },
  );

  // Save a draft → APPEND to \Drafts (no SMTP). Recipients are optional for a draft.
  // Reconciles the non-INBOX folders right after so the new draft surfaces promptly
  // instead of waiting for the next cron pass.
  app.post<{ Params: { id: string }; Body: SaveDraftRequest }>(
    '/api/accounts/:id/draft',
    async (req, reply) => {
      const engine = getEngine(req.params.id);
      if (!engine) return reply.code(404).send({ error: 'unknown account' });
      const result = await saveDraft(engine.accountConfig, req.body ?? { to: [], subject: '' });
      if (result.savedToDrafts) engine.reconcileFoldersNow();
      return result;
    },
  );
}
