/**
 * Message read surface: folder/archived listings, single-message detail, and search.
 * All return MessageDto/MessageDetailDto shaped from local SQLite (cache, don't proxy —
 * ARCHITECTURE §1). Message mutations live in `message-actions.ts`.
 */
import type { FastifyInstance } from 'fastify';
import type { MessageDto } from '@maily/shared';
import {
  attachmentsForMessage,
  attachmentsForMessages,
  folderIdsForMessage,
  folderIdsForMessages,
  getMessage,
  listArchived,
  listMessages,
  listStarred,
  listThread,
  listUnifiedByRole,
  listUnifiedInbox,
  type MessageRow,
  type UnifiedRole,
} from '../../db/queries.js';
import { embedInlineImages } from '../../storage/attachments.js';
import { toMessageDetailDto, toMessageDto } from '../../http/dto.js';
import { searchMessages } from '../../search/search.js';

const MAX_PAGE = 200;

/**
 * Parse the shared list query: a capped `limit` (default 50) + `before` cursor (ms) +
 * `unread=1` to return only unseen rows. The client uses the unread variant to surface
 * EVERY unread message on the first page when "unread at top" is enabled — the server
 * knows what to serve first, so page one never depends on how deep the client has paged.
 */
function pageParams(query: { limit?: string; before?: string; unread?: string }): {
  limit: number;
  before?: number;
  unread: boolean;
} {
  return {
    limit: Math.min(Number(query.limit ?? 50) || 50, MAX_PAGE),
    before: query.before ? Number(query.before) : undefined,
    unread: query.unread === '1' || query.unread === 'true',
  };
}

/** Shape a row list with two batched relation queries instead of two queries per row. */
const toListDtos = (rows: MessageRow[]): MessageDto[] => {
  const ids = rows.map((m) => m.id);
  const folderIds = folderIdsForMessages(ids);
  const attachmentRows = attachmentsForMessages(ids);
  return rows.map((m) =>
    toMessageDto(m, folderIds.get(m.id) ?? [], attachmentRows.get(m.id) ?? []),
  );
};

export async function messageRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Params: { folderId: string };
    Querystring: { limit?: string; before?: string; unread?: string };
  }>('/api/folders/:folderId/messages', async (req) => {
    const { limit, before, unread } = pageParams(req.query);
    const { folderId } = req.params;
    return toListDtos(listMessages(folderId, limit, before, unread));
  });

  // Virtual "Unified Inbox": every account's inbox merged into one stream.
  app.get<{ Querystring: { limit?: string; before?: string; unread?: string } }>(
    '/api/inbox',
    async (req) => {
      const { limit, before, unread } = pageParams(req.query);
      return toListDtos(listUnifiedInbox(limit, before, unread));
    },
  );

  // Generalised unified view: every account's folder of `role` merged into one
  // stream ("All sent", "All drafts", …). Inbox keeps its dedicated `/api/inbox`.
  const UNIFIED_ROLES: UnifiedRole[] = ['inbox', 'drafts', 'sent', 'junk', 'trash'];
  app.get<{
    Params: { role: string };
    Querystring: { limit?: string; before?: string; unread?: string };
  }>('/api/unified/:role', async (req, reply) => {
    const role = req.params.role as UnifiedRole;
    if (!UNIFIED_ROLES.includes(role)) return reply.code(404).send({ error: 'unknown role' });
    const { limit, before, unread } = pageParams(req.query);
    return toListDtos(listUnifiedByRole(role, limit, before, unread));
  });

  // Virtual "Archived" view for an account: archive-role folder minus inbox/sent/
  // trash/junk/drafts. Surfaces archived mail on Gmail, where "archive" == All Mail.
  app.get<{
    Params: { accountId: string };
    Querystring: { limit?: string; before?: string; unread?: string };
  }>('/api/accounts/:accountId/archived', async (req) => {
    const { limit, before, unread } = pageParams(req.query);
    const { accountId } = req.params;
    return toListDtos(listArchived(accountId, limit, before, unread));
  });

  // Virtual "Starred" view for an account: every \Flagged message, provider-agnostic.
  // mailbox.org / generic IMAP have no Starred folder; Gmail's [Gmail]/Starred is folded
  // in here too so every account gets one consistent Starred view.
  app.get<{
    Params: { accountId: string };
    Querystring: { limit?: string; before?: string; unread?: string };
  }>('/api/accounts/:accountId/starred', async (req) => {
    const { limit, before, unread } = pageParams(req.query);
    const { accountId } = req.params;
    return toListDtos(listStarred(accountId, limit, before, unread));
  });

  // Whole conversation for a message (threaded reader): every message sharing this
  // one's account + thread id, oldest-first and light (MessageDto — bodies stay lazy,
  // fetched per-card on expand). A message with no thread id is its own conversation.
  app.get<{ Params: { id: string } }>('/api/messages/:id/thread', async (req, reply) => {
    const m = getMessage(req.params.id);
    if (!m) return reply.code(404).send({ error: 'not found' });
    return toListDtos(m.threadId ? listThread(m.accountId, m.threadId) : [m]);
  });

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

  app.get<{
    Querystring: { q?: string; accountId?: string; limit?: string; threaded?: string };
  }>('/api/search', async (req) => {
    const q = (req.query.q ?? '').trim();
    if (!q) return [];
    const { limit } = pageParams(req.query);
    const hits = await searchMessages(q, { limit, accountId: req.query.accountId });
    if (req.query.threaded !== '1' && req.query.threaded !== 'true') return toListDtos(hits);

    // Expand each ranked hit to its complete local conversation so the search
    // row has the same participants/count/state as Inbox. Keep first-hit order
    // (relevance); subsequent hits from a thread don't duplicate it.
    const expanded: MessageRow[] = [];
    const seenThreads = new Set<string>();
    const seenMessages = new Set<string>();
    for (const hit of hits) {
      const threadKey = hit.threadId ? `${hit.accountId}:${hit.threadId}` : `m:${hit.id}`;
      if (seenThreads.has(threadKey)) continue;
      seenThreads.add(threadKey);
      const liveMembers = hit.threadId ? listThread(hit.accountId, hit.threadId) : [hit];
      // A Trash search intentionally returns tombstoned rows, while listThread's
      // normal reader contract hides tombstones. Never let expansion erase the hit.
      const members = liveMembers.length > 0 ? liveMembers : [hit];
      for (const member of members) {
        if (seenMessages.has(member.id)) continue;
        seenMessages.add(member.id);
        expanded.push(member);
      }
    }
    return toListDtos(expanded);
  });
}
