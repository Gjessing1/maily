/**
 * Outbound: send and save-draft. A SEND is no longer fired inline — it's queued into the
 * server-owned outbox (src/outbox) with a `dueAt`, so it commits server-side even if the PWA
 * closes. `dueAt` is either the requested scheduled time ("send later") or now + the configured
 * undo-send window (so an "immediate" send is still cancelable). The actual SMTP + provider-aware
 * Sent handling (ARCHITECTURE §10) runs in the outbox runner. Save-draft is unchanged (APPEND to
 * \Drafts, no SMTP).
 */
import type { FastifyInstance } from 'fastify';
import type { SaveDraftRequest, SendMessageRequest } from '@maily/shared';
import { getEngine } from '../../imap/registry.js';
import { saveDraft } from '../../mail/draft.js';
import { enqueueSend, nudgeOutbox } from '../../outbox/runner.js';
import { getPrefs } from '../../db/settings.js';

/** Undo-send window (seconds) from saved prefs; default 10, 0 = no hold. */
function undoSendSeconds(): number {
  const v = getPrefs().undoSendSeconds;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 10;
}

export async function composeRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string }; Body: SendMessageRequest }>(
    '/api/accounts/:id/send',
    async (req, reply) => {
      const engine = getEngine(req.params.id);
      if (!engine) return reply.code(404).send({ error: 'unknown account' });
      if (!req.body?.to?.length) return reply.code(400).send({ error: 'recipient required' });

      const now = Date.now();
      // A future sendAt schedules it; otherwise hold for the undo window (0 ⇒ effectively now).
      const scheduled = typeof req.body.sendAt === 'number' && req.body.sendAt > now;
      const dueAt = scheduled ? req.body.sendAt! : now + undoSendSeconds() * 1000;
      const outboxId = enqueueSend(req.params.id, req.body, dueAt);
      // Drain soon so a 0-window (immediate) send doesn't wait for the next poll tick.
      if (!scheduled) nudgeOutbox();
      return { outboxId, dueAt };
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
