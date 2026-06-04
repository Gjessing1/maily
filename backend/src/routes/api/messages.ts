/**
 * Message read surface: folder/archived listings, single-message detail, and search.
 * All return MessageDto/MessageDetailDto shaped from local SQLite (cache, don't proxy —
 * ARCHITECTURE §1). Message mutations live in `message-actions.ts`.
 */
import type { FastifyInstance } from 'fastify';
import {
  attachmentsForMessage,
  folderIdsForMessage,
  getMessage,
  listArchived,
  listMessages,
} from '../../db/queries.js';
import { embedInlineImages } from '../../storage/attachments.js';
import { toMessageDetailDto, toMessageDto } from '../../http/dto.js';
import { searchMessages } from '../../search/search.js';

const MAX_PAGE = 200;

export async function messageRoutes(app: FastifyInstance): Promise<void> {
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
}
