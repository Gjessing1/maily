/**
 * Message mutations: flag, delete (→ Trash), archive. Each follows the local-first
 * rule (ARCHITECTURE §2/§13): tombstone/flag/relink the local row + emit a signal
 * synchronously. Flags propagate to IMAP out-of-band over a transient connection.
 *
 * Delete and archive defer their IMAP MOVE into the **server-owned outbox** (src/outbox) with a
 * short `dueAt` window, so the move is undoable *and* commits server-side even if the PWA closes
 * mid-window (the old undo timer lived on the client and could be lost). The response carries the
 * outbox id + dueAt so the client can mirror the window and cancel (undo) against it.
 */
import type { FastifyInstance } from 'fastify';
import { emitSignal } from '../../events.js';
import { folderByRole, getMessage, uidLocationForMessage } from '../../db/queries.js';
import { markMessageDeleted, updateMessageFlags } from '../../imap/store.js';
import { withTransientConnection } from '../../imap/connection.js';
import { getEngine } from '../../imap/registry.js';
import { enqueueDelete, enqueueArchive } from '../../outbox/runner.js';

/** Undo window (ms) for a deferred delete/archive — how long the move is cancelable. */
const UNDO_WINDOW_MS = 5000;

export async function messageActionRoutes(app: FastifyInstance): Promise<void> {
  app.patch<{ Params: { id: string }; Body: { seen?: boolean; flagged?: boolean } }>(
    '/api/messages/:id/flags',
    async (req, reply) => {
      const m = getMessage(req.params.id);
      if (!m) return reply.code(404).send({ error: 'not found' });

      const seen = req.body.seen ?? m.seen;
      const flagged = req.body.flagged ?? m.flagged;
      updateMessageFlags(m.id, { seen, flagged, answered: m.answered, draft: m.draft });
      emitSignal({ type: 'mail:flags', accountId: m.accountId, messageId: m.id, seen, flagged });

      // Propagate to the IMAP server over a transient connection (don't disturb IDLE).
      // Fire-and-forget: the local DB + signal above already reflect the change, so we
      // must NOT block the HTTP response on this transient connection — under a heavy
      // background sweep it can be slow, and a client-side timeout would bounce the
      // optimistic UI update back. The next folder resync reconciles if it fails.
      const loc = uidLocationForMessage(m.id);
      const engine = loc ? getEngine(loc.accountId) : undefined;
      if (loc && engine) {
        void (async () => {
          try {
            await withTransientConnection(engine.accountConfig, async (client) => {
              const lock = await client.getMailboxLock(loc.folderPath);
              try {
                const uid = String(loc.uid);
                if (req.body.seen !== undefined) {
                  const op = seen ? client.messageFlagsAdd : client.messageFlagsRemove;
                  await op.call(client, uid, ['\\Seen'], { uid: true });
                }
                if (req.body.flagged !== undefined) {
                  const op = flagged ? client.messageFlagsAdd : client.messageFlagsRemove;
                  await op.call(client, uid, ['\\Flagged'], { uid: true });
                }
              } finally {
                lock.release();
              }
            });
          } catch (err) {
            app.log.warn(`flag propagation failed: ${(err as Error).message}`);
          }

          // A star/unstar changes membership of a flag-derived folder (Gmail's
          // [Gmail]/Starred). Kick an immediate non-INBOX reconcile so it shows in
          // that folder right away instead of after the next cron pass.
          if (req.body.flagged !== undefined) engine.reconcileFoldersNow();
        })();
      }

      return { ok: true, seen, flagged };
    },
  );

  // Soft-delete → move to Trash. Tombstone locally first (instant, optimistic) + emit the
  // signal, then queue the MOVE-to-Trash into the server-owned outbox with a short undo window
  // (ARCHITECTURE §2/§13). The outbox runner performs the UID MOVE to the role='trash' folder
  // at dueAt — a real trash on Gmail, a plain move on Dovecot; imapflow falls back to
  // COPY+\Deleted+EXPUNGE where MOVE is unadvertised — and an Undo cancels it within the window.
  app.delete<{ Params: { id: string } }>('/api/messages/:id', async (req, reply) => {
    const m = getMessage(req.params.id);
    if (!m) return reply.code(404).send({ error: 'not found' });

    markMessageDeleted(m.id);
    emitSignal({ type: 'mail:deleted', accountId: m.accountId, messageId: m.id });

    const dueAt = Date.now() + UNDO_WINDOW_MS;
    const outboxId = enqueueDelete(m.accountId, m.id, dueAt);
    return { ok: true, outboxId, dueAt };
  });

  // Archive → move the inbox copy to the role='archive' folder (Gmail "All Mail"
  // strips the INBOX label; generic IMAP moves to Archive). Unlike delete this does
  // NOT tombstone: the message stays live and listable, just out of the inbox. The MOVE is
  // queued into the outbox with an undo window; the runner resolves the inbox location and
  // performs the MOVE at dueAt (and skips it if the message is no longer in the inbox).
  app.post<{ Params: { id: string } }>('/api/messages/:id/archive', async (req, reply) => {
    const m = getMessage(req.params.id);
    if (!m) return reply.code(404).send({ error: 'not found' });

    const archive = folderByRole(m.accountId, 'archive');
    if (!archive) return reply.code(409).send({ error: 'no archive folder' });

    emitSignal({ type: 'mail:archived', accountId: m.accountId, messageId: m.id });

    const dueAt = Date.now() + UNDO_WINDOW_MS;
    const outboxId = enqueueArchive(m.accountId, m.id, dueAt);
    return { ok: true, outboxId, dueAt };
  });
}
