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
  listUnifiedByRole,
  listUnifiedInbox,
  type MessageRow,
  type UnifiedRole,
} from '../../db/queries.js';
import { embedInlineImages } from '../../storage/attachments.js';
import { toMessageDetailDto, toMessageDto } from '../../http/dto.js';
import { searchMessages } from '../../search/search.js';

const MAX_PAGE = 200;

/** Parse the shared list pagination query: a capped `limit` (default 50) + `before` cursor (ms). */
function pageParams(query: { limit?: string; before?: string }): {
  limit: number;
  before?: number;
} {
  return {
    limit: Math.min(Number(query.limit ?? 50) || 50, MAX_PAGE),
    before: query.before ? Number(query.before) : undefined,
  };
}

/** Shape a row list to MessageDto, attaching each message's folder ids + attachments. */
const toListDtos = (rows: MessageRow[]) =>
  rows.map((m) => toMessageDto(m, folderIdsForMessage(m.id), attachmentsForMessage(m.id)));

export async function messageRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { folderId: string }; Querystring: { limit?: string; before?: string } }>(
    '/api/folders/:folderId/messages',
    async (req) => {
      const { limit, before } = pageParams(req.query);
      return toListDtos(listMessages(req.params.folderId, limit, before));
    },
  );

  // Virtual "Unified Inbox": every account's inbox merged into one stream.
  app.get<{ Querystring: { limit?: string; before?: string } }>('/api/inbox', async (req) => {
    const { limit, before } = pageParams(req.query);
    return toListDtos(listUnifiedInbox(limit, before));
  });

  // Generalised unified view: every account's folder of `role` merged into one
  // stream ("All sent", "All drafts", …). Inbox keeps its dedicated `/api/inbox`.
  const UNIFIED_ROLES: UnifiedRole[] = ['inbox', 'drafts', 'sent', 'junk', 'trash'];
  app.get<{ Params: { role: string }; Querystring: { limit?: string; before?: string } }>(
    '/api/unified/:role',
    async (req, reply) => {
      const role = req.params.role as UnifiedRole;
      if (!UNIFIED_ROLES.includes(role)) return reply.code(404).send({ error: 'unknown role' });
      const { limit, before } = pageParams(req.query);
      return toListDtos(listUnifiedByRole(role, limit, before));
    },
  );

  // Virtual "Archived" view for an account: archive-role folder minus inbox/sent/
  // trash/junk/drafts. Surfaces archived mail on Gmail, where "archive" == All Mail.
  app.get<{ Params: { accountId: string }; Querystring: { limit?: string; before?: string } }>(
    '/api/accounts/:accountId/archived',
    async (req) => {
      const { limit, before } = pageParams(req.query);
      return toListDtos(listArchived(req.params.accountId, limit, before));
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
      const { limit } = pageParams(req.query);
      return toListDtos(await searchMessages(q, { limit, accountId: req.query.accountId }));
    },
  );
}
