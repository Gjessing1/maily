/**
 * Protected HTTP API. Everything here requires a valid JWT (onRequest hook).
 * Heavy payloads (bodies, attachment bytes) go over HTTP — never sockets
 * (ARCHITECTURE §3). Attachment bytes are fetched on demand and streamed to disk,
 * never buffered (ARCHITECTURE §4).
 */
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import type {
  AccountSyncStatusDto,
  ContactCardInput,
  PushSubscriptionDto,
  SendMessageRequest,
  ServerConfigDto,
  UploadDto,
} from '@maily/shared';
import { env } from '../env.js';
import { authenticate } from '../http/auth.js';
import { emitSignal } from '../events.js';
import {
  attachmentsForMessage,
  deletePushSubscription,
  folderByRole,
  folderIdsForMessage,
  folderMessageCount,
  getAttachment,
  getMessage,
  listAccounts,
  listArchived,
  listFolders,
  listMessages,
  savePushSubscription,
  uidLocationForMessage,
  uidLocationInFolder,
} from '../db/queries.js';
import { embedInlineImages, ensureAttachmentOnDisk } from '../storage/attachments.js';
import { markMessageDeleted, relinkMessageToFolder, updateMessageFlags } from '../imap/store.js';
import { withTransientConnection } from '../imap/connection.js';
import { allEngines, getEngine } from '../imap/registry.js';
import { toAccountDto, toFolderDto, toMessageDetailDto, toMessageDto } from '../http/dto.js';
import { sendMessage } from '../mail/send.js';
import { searchMessages } from '../search/search.js';
import { getCardByKey, listCards, searchContacts } from '../contacts/store.js';
import { CardDavError, createCard, deleteCard, updateCard } from '../contacts/carddav.js';
import { deleteUpload } from '../storage/uploads.js';
import { vapidPublicKey } from '../push/webpush.js';

const MAX_PAGE = 200;
/** Cap on a single composer attachment upload (streamed straight to disk). */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export async function apiRoutes(app: FastifyInstance): Promise<void> {
  // Gate the whole encapsulated plugin behind JWT auth.
  app.addHook('onRequest', authenticate);

  // Raw binary uploads (composer attachments) arrive as octet-stream; pass the
  // request stream straight through so the route can pipe it to disk unbuffered.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) =>
    done(null, payload),
  );

  // Non-secret server config (Settings → Storage shows the server cache window).
  app.get(
    '/api/config',
    async (): Promise<ServerConfigDto> => ({
      cacheWindowDays: env.cacheWindowDays,
    }),
  );

  app.get('/api/accounts', async () => listAccounts().map(toAccountDto));

  app.get<{ Params: { id: string } }>('/api/accounts/:id/folders', async (req) =>
    listFolders(req.params.id).map(toFolderDto),
  );

  // Sync status: live connection + last-sync + per-folder cached counts (Settings → Sync).
  app.get('/api/sync/status', async (): Promise<AccountSyncStatusDto[]> => {
    const byId = new Map(listAccounts().map((a) => [a.id, a]));
    return allEngines().map((engine) => {
      const acc = byId.get(engine.id);
      const { connected, lastSyncAt } = engine.status;
      return {
        accountId: engine.id,
        email: acc?.email ?? '',
        provider: acc?.provider ?? '',
        connected,
        lastSyncAt,
        folders: listFolders(engine.id).map((f) => ({
          id: f.id,
          name: f.name,
          role: f.role,
          cached: folderMessageCount(f.id),
          synced: f.uidValidity !== null,
        })),
      };
    });
  });

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

  // Virtual "Archived" view for an account: archive-role folder minus inbox/sent/
  // trash/junk/drafts. Surfaces archived mail on Gmail, where "archive" == All Mail.
  app.get<{ Params: { accountId: string }; Querystring: { limit?: string; before?: string } }>(
    '/api/accounts/:accountId/archived',
    async (req) => {
      const limit = Math.min(Number(req.query.limit ?? 50) || 50, MAX_PAGE);
      const before = req.query.before ? Number(req.query.before) : undefined;
      const rows = listArchived(req.params.accountId, limit, before);
      return rows.map((m) =>
        toMessageDto(m, folderIdsForMessage(m.id), attachmentsForMessage(m.id)),
      );
    },
  );

  app.get<{ Params: { id: string } }>('/api/messages/:id', async (req, reply) => {
    const m = getMessage(req.params.id);
    if (!m) return reply.code(404).send({ error: 'not found' });
    const atts = attachmentsForMessage(m.id);
    const dto = toMessageDetailDto(m, folderIdsForMessage(m.id), atts);
    // Embed inline CID images as data: URIs so they render in the sandboxed,
    // null-origin reader iframe (ROADMAP §3.7.A). Inline parts that couldn't be
    // embedded (over the size cap, or unreferenced) surface in the attachments
    // panel instead — flip their isInline hint so the client stops hiding them.
    const { html, embeddedIds } = await embedInlineImages(dto.bodyHtml, atts);
    dto.bodyHtml = html;
    dto.attachments = dto.attachments.map((a) =>
      a.isInline && !embeddedIds.has(a.id) ? { ...a, isInline: false } : a,
    );
    return dto;
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

        // A star/unstar changes membership of a flag-derived folder (Gmail's
        // [Gmail]/Starred). Kick an immediate non-INBOX reconcile so it shows in
        // that folder right away instead of after the next cron pass.
        if (req.body.flagged !== undefined) engine.reconcileFoldersNow();
      }

      emitSignal({ type: 'mail:flags', accountId: m.accountId, messageId: m.id, seen, flagged });
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
    if (!trash) {
      app.log.warn(
        `no trash folder for account ${m.accountId}; message ${m.id} tombstoned locally`,
      );
    } else if (loc && engine && loc.folderPath !== trash.path) {
      try {
        const newUid = await withTransientConnection(engine.accountConfig, async (client) => {
          const lock = await client.getMailboxLock(loc.folderPath);
          try {
            const res = await client.messageMove(String(loc.uid), trash.path, { uid: true });
            // uidMap (source→dest UID) is present when the server supports MOVE/COPYUID.
            return res ? (res.uidMap?.get(loc.uid) ?? null) : null;
          } finally {
            lock.release();
          }
        });
        // Converge the local mapping onto Trash so the message stays fetchable; the
        // tombstone is preserved (Trash re-sights never clear it — see store.ts).
        relinkMessageToFolder(m.id, trash.id, newUid);
      } catch (err) {
        app.log.warn(`trash move failed for ${m.id}: ${(err as Error).message}`);
      }
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

    const engine = getEngine(m.accountId);
    if (engine) {
      try {
        const newUid = await withTransientConnection(engine.accountConfig, async (client) => {
          const lock = await client.getMailboxLock(loc.folderPath);
          try {
            const res = await client.messageMove(String(loc.uid), archive.path, { uid: true });
            return res ? (res.uidMap?.get(loc.uid) ?? null) : null;
          } finally {
            lock.release();
          }
        });
        relinkMessageToFolder(m.id, archive.id, newUid);
      } catch (err) {
        app.log.warn(`archive move failed for ${m.id}: ${(err as Error).message}`);
      }
    }

    return { ok: true };
  });

  app.get<{ Params: { id: string; attId: string } }>(
    '/api/messages/:id/attachments/:attId',
    async (req, reply) => {
      const att = getAttachment(req.params.attId);
      if (!att || att.messageId !== req.params.id) {
        return reply.code(404).send({ error: 'not found' });
      }

      // Lazy fetch: materialise the bytes on disk (from IMAP) if not yet downloaded.
      const path = await ensureAttachmentOnDisk(att);
      if (!path) return reply.code(409).send({ error: 'attachment bytes unavailable' });

      reply.header('Content-Type', att.mimeType ?? 'application/octet-stream');
      if (att.filename) {
        reply.header('Content-Disposition', `inline; filename="${att.filename.replace(/"/g, '')}"`);
      }
      return reply.send(createReadStream(path));
    },
  );

  // Stage a composer attachment: stream the raw body to the uploads dir, capped at
  // MAX_UPLOAD_BYTES, returning a handle the send route resolves by uploadId.
  app.post<{ Querystring: { filename?: string; type?: string } }>(
    '/api/uploads',
    async (req, reply): Promise<UploadDto | undefined> => {
      const uploadId = randomUUID();
      const path = join(env.uploadsDir, uploadId);
      const filename = (req.query.filename ?? 'attachment').slice(0, 255);
      const mimeType = req.query.type ?? null;

      let total = 0;
      const limiter = new Transform({
        transform(chunk, _enc, cb) {
          total += chunk.length;
          if (total > MAX_UPLOAD_BYTES) cb(new Error('upload too large'));
          else cb(null, chunk);
        },
      });

      try {
        await pipeline(req.body as NodeJS.ReadableStream, limiter, createWriteStream(path));
      } catch (err) {
        await unlink(path).catch(() => undefined);
        return reply.code(413).send({ error: (err as Error).message });
      }
      return { uploadId, filename, mimeType, sizeBytes: total };
    },
  );

  // Discard a staged upload (user removed the chip before sending).
  app.delete<{ Params: { id: string } }>('/api/uploads/:id', async (req) => {
    await deleteUpload(req.params.id);
    return { ok: true };
  });

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

  // Contact autocomplete for the composer (cached CardDAV addressbook).
  app.get<{ Querystring: { q?: string; limit?: string } }>('/api/contacts', async (req) => {
    const q = (req.query.q ?? '').trim();
    if (!q) return [];
    const limit = Math.min(Number(req.query.limit ?? 8) || 8, 25);
    return searchContacts(q, limit);
  });

  // --- Contact card management (CardDAV write-back) ---

  // Clean a create/update payload into a name + a deduped list of trimmed emails.
  const normalizeCard = (body: ContactCardInput | undefined) => {
    const name = body?.name?.trim() || null;
    const seen = new Set<string>();
    const emails: string[] = [];
    for (const raw of body?.emails ?? []) {
      const e = String(raw).trim();
      const key = e.toLowerCase();
      if (e && /.+@.+/.test(e) && !seen.has(key)) {
        seen.add(key);
        emails.push(e);
      }
    }
    return { name, emails };
  };

  // List the whole addressbook as cards for the manager UI.
  app.get('/api/contacts/cards', async () => listCards());

  // Create a new card. UID is assigned server-side.
  app.post<{ Body: ContactCardInput }>('/api/contacts/cards', async (req, reply) => {
    const { name, emails } = normalizeCard(req.body);
    if (emails.length === 0) return reply.code(400).send({ error: 'at least one email required' });
    try {
      const uid = await createCard(name, emails);
      return reply.code(201).send({ uid, name, emails });
    } catch (err) {
      const status = err instanceof CardDavError ? err.status : 502;
      return reply.code(status).send({ error: (err as Error).message });
    }
  });

  // Update an existing card by its key (vCard UID, or href for UID-less cards).
  app.put<{ Params: { key: string }; Body: ContactCardInput }>(
    '/api/contacts/cards/:key',
    async (req, reply) => {
      const card = getCardByKey(req.params.key);
      if (!card?.href) return reply.code(404).send({ error: 'card not found' });
      const { name, emails } = normalizeCard(req.body);
      if (emails.length === 0)
        return reply.code(400).send({ error: 'at least one email required' });
      try {
        await updateCard(card.uid, card.href, card.etag, name, emails);
        return { uid: card.uid, name, emails };
      } catch (err) {
        const status = err instanceof CardDavError ? err.status : 502;
        return reply.code(status).send({ error: (err as Error).message });
      }
    },
  );

  // Delete a card by its key.
  app.delete<{ Params: { key: string } }>('/api/contacts/cards/:key', async (req, reply) => {
    const card = getCardByKey(req.params.key);
    if (!card?.href) return reply.code(404).send({ error: 'card not found' });
    try {
      await deleteCard(card.href);
      return { ok: true };
    } catch (err) {
      const status = err instanceof CardDavError ? err.status : 502;
      return reply.code(status).send({ error: (err as Error).message });
    }
  });

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
