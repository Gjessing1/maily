/**
 * Protected HTTP API. Everything here requires a valid JWT (onRequest hook).
 * Heavy payloads (bodies, attachment bytes) go over HTTP — never sockets
 * (ARCHITECTURE §3). Attachment bytes are fetched on demand and streamed to disk,
 * never buffered (ARCHITECTURE §4).
 */
import { createReadStream, createWriteStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import type { PushSubscriptionDto, SendMessageRequest } from '@maily/shared';
import { env } from '../env.js';
import { authenticate } from '../http/auth.js';
import { emitSignal } from '../events.js';
import {
  attachmentsForMessage,
  deletePushSubscription,
  folderIdsForMessage,
  getAttachment,
  getMessage,
  listAccounts,
  listFolders,
  listMessages,
  markAttachmentDownloaded,
  savePushSubscription,
  uidLocationForMessage,
} from '../db/queries.js';
import { updateMessageFlags } from '../imap/store.js';
import { withTransientConnection } from '../imap/connection.js';
import { getEngine } from '../imap/registry.js';
import { toAccountDto, toFolderDto, toMessageDetailDto, toMessageDto } from '../http/dto.js';
import { sendMessage } from '../mail/send.js';
import { searchMessages } from '../search/search.js';
import { vapidPublicKey } from '../push/webpush.js';

const MAX_PAGE = 200;

export async function apiRoutes(app: FastifyInstance): Promise<void> {
  // Gate the whole encapsulated plugin behind JWT auth.
  app.addHook('onRequest', authenticate);

  app.get('/api/accounts', async () => listAccounts().map(toAccountDto));

  app.get<{ Params: { id: string } }>('/api/accounts/:id/folders', async (req) =>
    listFolders(req.params.id).map(toFolderDto),
  );

  app.get<{ Params: { folderId: string }; Querystring: { limit?: string; before?: string } }>(
    '/api/folders/:folderId/messages',
    async (req) => {
      const limit = Math.min(Number(req.query.limit ?? 50) || 50, MAX_PAGE);
      const before = req.query.before ? Number(req.query.before) : undefined;
      const rows = listMessages(req.params.folderId, limit, before);
      return rows.map((m) =>
        toMessageDto(m, folderIdsForMessage(m.id), attachmentsForMessage(m.id)),
      );
    },
  );

  app.get<{ Params: { id: string } }>('/api/messages/:id', async (req, reply) => {
    const m = getMessage(req.params.id);
    if (!m) return reply.code(404).send({ error: 'not found' });
    return toMessageDetailDto(m, folderIdsForMessage(m.id), attachmentsForMessage(m.id));
  });

  app.patch<{ Params: { id: string }; Body: { seen?: boolean; flagged?: boolean } }>(
    '/api/messages/:id/flags',
    async (req, reply) => {
      const m = getMessage(req.params.id);
      if (!m) return reply.code(404).send({ error: 'not found' });

      const seen = req.body.seen ?? m.seen;
      const flagged = req.body.flagged ?? m.flagged;
      updateMessageFlags(m.id, { seen, flagged, answered: m.answered, draft: m.draft });

      // Propagate to the IMAP server over a transient connection (don't disturb IDLE).
      const loc = uidLocationForMessage(m.id);
      const engine = loc ? getEngine(loc.accountId) : undefined;
      if (loc && engine) {
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
      }

      emitSignal({ type: 'mail:flags', accountId: m.accountId, messageId: m.id, seen, flagged });
      return { ok: true, seen, flagged };
    },
  );

  app.get<{ Params: { id: string; attId: string } }>(
    '/api/messages/:id/attachments/:attId',
    async (req, reply) => {
      const att = getAttachment(req.params.attId);
      if (!att || att.messageId !== req.params.id) {
        return reply.code(404).send({ error: 'not found' });
      }

      let path = att.storagePath;
      if (!path || !existsSync(path)) {
        // Lazy fetch: pull the bytes from IMAP now, streaming straight to disk.
        const loc = uidLocationForMessage(req.params.id);
        const engine = loc ? getEngine(loc.accountId) : undefined;
        if (!loc || !engine || !att.imapPartId) {
          return reply.code(409).send({ error: 'attachment bytes unavailable' });
        }
        path = join(env.attachmentsDir, att.id);
        await withTransientConnection(engine.accountConfig, async (client) => {
          const lock = await client.getMailboxLock(loc.folderPath);
          try {
            const { content } = await client.download(String(loc.uid), att.imapPartId!, {
              uid: true,
            });
            await pipeline(content, createWriteStream(path!));
          } finally {
            lock.release();
          }
        });
        markAttachmentDownloaded(att.id, path, statSync(path).size);
      }

      reply.header('Content-Type', att.mimeType ?? 'application/octet-stream');
      if (att.filename) {
        reply.header('Content-Disposition', `inline; filename="${att.filename.replace(/"/g, '')}"`);
      }
      return reply.send(createReadStream(path));
    },
  );

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

  app.get<{ Querystring: { q?: string; accountId?: string; limit?: string } }>(
    '/api/search',
    async (req) => {
      const q = (req.query.q ?? '').trim();
      if (!q) return [];
      const limit = Math.min(Number(req.query.limit ?? 50) || 50, MAX_PAGE);
      const rows = await searchMessages(q, { limit, accountId: req.query.accountId });
      return rows.map((m) =>
        toMessageDto(m, folderIdsForMessage(m.id), attachmentsForMessage(m.id)),
      );
    },
  );

  // --- Web Push subscription management ---
  app.get('/api/push/key', async () => ({ publicKey: vapidPublicKey() }));

  app.post<{ Body: PushSubscriptionDto }>('/api/push/subscribe', async (req, reply) => {
    const sub = req.body;
    if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
      return reply.code(400).send({ error: 'invalid subscription' });
    }
    savePushSubscription(sub.endpoint, sub.keys.p256dh, sub.keys.auth);
    return { ok: true };
  });

  app.post<{ Body: { endpoint?: string } }>('/api/push/unsubscribe', async (req) => {
    if (req.body?.endpoint) deletePushSubscription(req.body.endpoint);
    return { ok: true };
  });
}
