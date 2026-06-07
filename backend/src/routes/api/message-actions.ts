/**
 * Message mutations: flag, delete (→ Trash), archive. Each follows the local-first
 * rule (ARCHITECTURE §2/§13): tombstone/flag/relink the local row + emit a signal
 * synchronously, then propagate to IMAP out-of-band over a transient connection so
 * the INBOX IDLE connection is never disturbed and the HTTP response never blocks on
 * a (possibly slow) transient connection. The next folder resync reconciles on failure.
 */
import type { FastifyInstance } from 'fastify';
import { emitSignal } from '../../events.js';
import {
  folderByRole,
  getMessage,
  uidLocationForMessage,
  uidLocationInFolder,
} from '../../db/queries.js';
import { markMessageDeleted, updateMessageFlags } from '../../imap/store.js';
import { withTransientConnection } from '../../imap/connection.js';
import { moveToFolderOnServer } from '../../imap/move.js';
import { getEngine } from '../../imap/registry.js';

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

  // Soft-delete → move to Trash. Tombstone locally first (instant, optimistic),
  // then MOVE on IMAP out-of-band over a transient connection so INBOX IDLE is
  // never disturbed (ARCHITECTURE §2/§13). The provider-agnostic primitive is a
  // UID MOVE to the role='trash' folder — a real trash on Gmail, a plain move on
  // Dovecot; imapflow falls back to COPY+\Deleted+EXPUNGE where MOVE is unadvertised.
  app.delete<{ Params: { id: string } }>('/api/messages/:id', async (req, reply) => {
    const m = getMessage(req.params.id);
    if (!m) return reply.code(404).send({ error: 'not found' });

    markMessageDeleted(m.id);
    emitSignal({ type: 'mail:deleted', accountId: m.accountId, messageId: m.id });

    const trash = folderByRole(m.accountId, 'trash');
    const loc = uidLocationForMessage(m.id);
    const engine = getEngine(m.accountId);
    // Out-of-band, fire-and-forget: the tombstone + signal above already hide the
    // message, so the HTTP response must not block on the transient-connection MOVE
    // (slow under a heavy sweep → client timeout → the row flickers back).
    if (!trash) {
      app.log.warn(
        `no trash folder for account ${m.accountId}; message ${m.id} tombstoned locally`,
      );
    } else if (loc && engine && loc.folderPath !== trash.path) {
      // The tombstone is preserved across the move (Trash re-sights never clear it —
      // see store.ts), so converging the mapping onto Trash keeps the row fetchable.
      void moveToFolderOnServer(engine.accountConfig, m.id, loc, trash).catch((err: Error) =>
        app.log.warn(`trash move failed for ${m.id}: ${err.message}`),
      );
    }

    return { ok: true };
  });

  // Archive → move the inbox copy to the role='archive' folder (Gmail "All Mail"
  // strips the INBOX label; generic IMAP moves to Archive). Unlike delete this does
  // NOT tombstone: the message stays live and listable, just out of the inbox. Same
  // out-of-band MOVE over a transient connection so INBOX IDLE is undisturbed.
  app.post<{ Params: { id: string } }>('/api/messages/:id/archive', async (req, reply) => {
    const m = getMessage(req.params.id);
    if (!m) return reply.code(404).send({ error: 'not found' });

    const archive = folderByRole(m.accountId, 'archive');
    if (!archive) return reply.code(409).send({ error: 'no archive folder' });
    const inbox = folderByRole(m.accountId, 'inbox');
    const loc = inbox ? uidLocationInFolder(m.id, inbox.id) : undefined;
    // Not in the inbox (already archived / elsewhere) → nothing to do.
    if (!loc || loc.folderPath === archive.path) return { ok: true };

    emitSignal({ type: 'mail:archived', accountId: m.accountId, messageId: m.id });

    // Out-of-band, fire-and-forget (same rationale as flags/delete): don't block the
    // response on the transient-connection MOVE so the optimistic UI stays snappy
    // under load; the next inbox resync reconciles if the move fails.
    const engine = getEngine(m.accountId);
    if (engine) {
      void moveToFolderOnServer(engine.accountConfig, m.id, loc, archive).catch((err: Error) =>
        app.log.warn(`archive move failed for ${m.id}: ${err.message}`),
      );
    }

    return { ok: true };
  });
}
