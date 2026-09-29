/**
 * Message mutations: flag, delete (→ Trash), archive, restore, delete forever.
 *
 * Flag, delete and archive are mailbox intents in the **server-owned outbox** (src/outbox): the
 * enqueue applies the local effect (flag / tombstone / leave the inbox) and signals, the runner
 * pushes it to the provider, and if the provider never takes it the inverse is applied. Delete
 * and archive get a short `dueAt` undo window; the response carries the outbox id + dueAt so the
 * client can mirror the window and cancel (undo) against it. Flags are due at once.
 *
 * Restore and delete-forever are deliberate corrective actions, so they stay awaited: their
 * failure is visible in the response, with nothing local changed.
 */
import type { FastifyInstance } from 'fastify';
import { emitSignal } from '../../events.js';
import { folderByRole, getMessage } from '../../db/queries.js';
import { serverPlacement } from '../../db/placement.js';
import { relinkMessageToFolder, restoreMessageDeleted } from '../../imap/store.js';
import { withTransientConnection } from '../../imap/connection.js';
import { moveToFolderOnServer } from '../../imap/move.js';
import { getEngine } from '../../imap/registry.js';
import { purgeMessage } from '../../cleanup/purge.js';
import { enqueueArchive, enqueueDelete, enqueueFlags } from '../../outbox/runner.js';

/** Undo window (ms) for a deferred delete/archive — how long the move is cancelable. */
const UNDO_WINDOW_MS = 5000;

export async function messageActionRoutes(app: FastifyInstance): Promise<void> {
  app.patch<{ Params: { id: string }; Body: { seen?: boolean; flagged?: boolean } }>(
    '/api/messages/:id/flags',
    async (req, reply) => {
      const m = getMessage(req.params.id);
      if (!m) return reply.code(404).send({ error: 'not found' });

      const set: { seen?: boolean; flagged?: boolean } = {};
      if (typeof req.body.seen === 'boolean') set.seen = req.body.seen;
      if (typeof req.body.flagged === 'boolean') set.flagged = req.body.flagged;
      if (Object.keys(set).length === 0) return { ok: true, seen: m.seen, flagged: m.flagged };
      const { seen, flagged } = enqueueFlags(m.accountId, m.id, set);
      return { ok: true, seen, flagged };
    },
  );

  // Soft-delete → move to Trash. The enqueue tombstones locally (instant) and signals; the
  // outbox runner performs the UID MOVE to the role='trash' folder at dueAt — a real trash on
  // Gmail, a plain move on Dovecot; imapflow falls back to COPY+\Deleted+EXPUNGE where MOVE is
  // unadvertised — and an Undo cancels it within the window.
  app.delete<{ Params: { id: string } }>('/api/messages/:id', async (req, reply) => {
    const m = getMessage(req.params.id);
    if (!m) return reply.code(404).send({ error: 'not found' });

    const dueAt = Date.now() + UNDO_WINDOW_MS;
    const outboxId = enqueueDelete(m.accountId, m.id, dueAt);
    return { ok: true, outboxId, dueAt };
  });

  // Restore from Trash → move the message back to the Inbox and clear the tombstone — the
  // "undo a mistaken delete" path once the delete's short undo window has elapsed. A deliberate
  // corrective action, so it's awaited (no undo window / outbox deferral): the IMAP MOVE runs over
  // a transient connection and relinks the local row onto the inbox, then the tombstone is cleared.
  // A local-only message (detached; no server copy) restores with a purely local relink.
  app.post<{ Params: { id: string } }>('/api/messages/:id/restore', async (req, reply) => {
    const m = getMessage(req.params.id);
    if (!m) return reply.code(404).send({ error: 'not found' });

    const inbox = folderByRole(m.accountId, 'inbox');
    if (!inbox) return reply.code(409).send({ error: 'no inbox folder' });

    const loc = serverPlacement(m.id);
    if (loc.kind === 'unplaced') return reply.code(409).send({ error: 'no server location' });
    if (loc.kind === 'local-only') {
      relinkMessageToFolder(m.id, inbox.id, null);
    } else {
      const engine = getEngine(m.accountId);
      if (!engine) return reply.code(503).send({ error: 'account offline' });

      try {
        // MOVE Trash → Inbox and relink locally (on Gmail this swaps the Trash label for Inbox).
        await moveToFolderOnServer(engine.accountConfig, m.id, loc, {
          id: inbox.id,
          path: inbox.path,
        });
      } catch (err) {
        // The server copy may already be gone (provider auto-purged its Trash) — nothing to restore.
        app.log.warn(`restore failed: ${(err as Error).message}`);
        return reply
          .code(502)
          .send({ error: 'could not restore — message no longer on the server' });
      }
    }

    restoreMessageDeleted(m.id);
    emitSignal({ type: 'mail:restored', accountId: m.accountId, messageId: m.id });
    return { ok: true };
  });

  // Delete forever (Trash only) → EXPUNGE the provider's copy, then purge the local one
  // (same no-resync tombstone as "Empty Trash"). A deliberate, unrecoverable action, so the
  // server step is awaited and a connection failure aborts before anything is lost locally.
  // A local-only message (detached; no server copy) skips straight to the local purge.
  app.delete<{ Params: { id: string } }>('/api/messages/:id/forever', async (req, reply) => {
    const m = getMessage(req.params.id);
    if (!m) return reply.code(404).send({ error: 'not found' });

    const trash = folderByRole(m.accountId, 'trash');
    const loc = trash ? serverPlacement(m.id, trash.id) : undefined;
    if (loc?.kind !== 'local-only') {
      if (loc?.kind !== 'server') return reply.code(409).send({ error: 'message is not in Trash' });
      const engine = getEngine(m.accountId);
      if (!engine) return reply.code(503).send({ error: 'account offline' });
      try {
        await withTransientConnection(engine.accountConfig, async (client) => {
          const lock = await client.getMailboxLock(loc.folderPath);
          try {
            // \Deleted + EXPUNGE. False = UID already gone (provider auto-purged) — the
            // goal state is reached either way, so only a thrown (connection) error aborts.
            await client.messageDelete(String(loc.uid), { uid: true });
          } finally {
            lock.release();
          }
        });
      } catch (err) {
        app.log.warn(`delete forever failed: ${(err as Error).message}`);
        return reply.code(502).send({ error: 'could not reach the mail server — nothing deleted' });
      }
    }

    purgeMessage(m.id); // emits mail:deleted + refreshes cleanup analytics
    return { ok: true };
  });

  // Archive → move the inbox copy to the role='archive' folder (Gmail "All Mail"
  // strips the INBOX label; generic IMAP moves to Archive). Unlike delete this does
  // NOT tombstone: the message stays live and listable, just out of the inbox. The enqueue
  // swaps its inbox mapping for an archive one locally; the runner MOVEs the inbox copy at
  // dueAt (nothing to move if it wasn't in the inbox).
  app.post<{ Params: { id: string } }>('/api/messages/:id/archive', async (req, reply) => {
    const m = getMessage(req.params.id);
    if (!m) return reply.code(404).send({ error: 'not found' });

    const archive = folderByRole(m.accountId, 'archive');
    if (!archive) return reply.code(409).send({ error: 'no archive folder' });

    const dueAt = Date.now() + UNDO_WINDOW_MS;
    const outboxId = enqueueArchive(m.accountId, m.id, archive.id, dueAt);
    return { ok: true, outboxId, dueAt };
  });
}
