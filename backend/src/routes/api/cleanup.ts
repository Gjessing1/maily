/**
 * Cleanup Dashboard API (ROADMAP Phase 6 "Master archive & Cleanup Dashboard").
 * Read-only deterministic analytics over the local SQLite archive (a storage audit plus the
 * delete-eligible slices — senders never replied to, cold-storage candidates, large messages,
 * unread-and-old, newsletters — each with its preview impact) PLUS the Phase 6b execution
 * path: POST /execute queues a slice for trashing and GET /queue reports trickle progress.
 *
 * Safety invariants on execute: the client sends only the slice + filters (never a message
 * list), and `sliceMessageIds` re-runs the SAME predicates the preview used — so the HARD
 * safety gate (financial/legal/account/medical) is re-applied at execution time. Trash-only:
 * messages are tombstoned locally then MOVEd to Trash by the rate-limited queue, never
 * EXPUNGEd, so the action is recoverable (archive-before-delete staging).
 */
import type { FastifyInstance } from 'fastify';
import type {
  CleanupDashboardDto,
  CleanupExecuteRequest,
  CleanupExecuteResultDto,
  CleanupMessagesDto,
} from '@maily/shared';
import {
  isDeleteSlice,
  paginateSlice,
  sliceMessageIds,
  sliceMessages,
} from '../../cleanup/slices.js';
import { cachedSliceData, cachedSummary } from '../../cleanup/cache.js';
import { enqueueTrash, nudgeTrashQueue, queueStatus } from '../../cleanup/trashQueue.js';
import { markMessageDeleted } from '../../imap/store.js';
import { emitSignal } from '../../events.js';

/** Parse the shared group-list paging/search query (`q` substring + `offset`). */
function pageOpts(q: { offset?: string; q?: string }): { q?: string; offset?: number } {
  const off = Number(q.offset);
  return {
    q: q.q?.trim() ? q.q.trim() : undefined,
    offset: Number.isFinite(off) && off > 0 ? off : undefined,
  };
}

/** Parse a positive numeric query param, or undefined (slice defaults apply). */
function posNum(raw: string | undefined): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

type PageQuery = { offset?: string; q?: string };

export async function cleanupRoutes(app: FastifyInstance): Promise<void> {
  // Headline figures: total live mail, estimated bytes, protected-from-cleanup count.
  app.get('/api/cleanup/summary', async () => cachedSummary());

  // The whole dashboard in one round-trip (summary + queue + first page of every slice),
  // served from the precomputed cache so entering the Cleanup screen is instant.
  app.get<{ Querystring: { years?: string; minMb?: string; months?: string } }>(
    '/api/cleanup/dashboard',
    async (req): Promise<CleanupDashboardDto> => {
      const years = posNum(req.query.years);
      const minMb = posNum(req.query.minMb);
      const months = posNum(req.query.months);
      return {
        summary: cachedSummary(),
        queue: queueStatus(),
        storage: paginateSlice('storage', cachedSliceData('storage')),
        neverReplied: paginateSlice('never-replied', cachedSliceData('never-replied')),
        coldStorage: paginateSlice('cold-storage', cachedSliceData('cold-storage', { years })),
        large: paginateSlice('large', cachedSliceData('large', { minMb })),
        unread: paginateSlice('unread', cachedSliceData('unread', { months })),
        newsletters: paginateSlice('newsletters', cachedSliceData('newsletters')),
      };
    },
  );

  // Storage audit — every sender domain by estimated bytes (informational, not a preset).
  app.get<{ Querystring: PageQuery }>('/api/cleanup/storage', async (req) =>
    paginateSlice('storage', cachedSliceData('storage'), pageOpts(req.query)),
  );

  // Senders never written back to — a passive bulk-unsubscribe / clutter candidate.
  app.get<{ Querystring: PageQuery }>('/api/cleanup/never-replied', async (req) =>
    paginateSlice('never-replied', cachedSliceData('never-replied'), pageOpts(req.query)),
  );

  // Cold-storage candidates — old mail without value markers (invoice/tax/contract).
  app.get<{ Querystring: PageQuery & { years?: string } }>(
    '/api/cleanup/cold-storage',
    async (req) =>
      paginateSlice(
        'cold-storage',
        cachedSliceData('cold-storage', { years: posNum(req.query.years) }),
        pageOpts(req.query),
      ),
  );

  // Large messages — estimated size over the `minMb` threshold (the size angle).
  app.get<{ Querystring: PageQuery & { minMb?: string } }>('/api/cleanup/large', async (req) =>
    paginateSlice(
      'large',
      cachedSliceData('large', { minMb: posNum(req.query.minMb) }),
      pageOpts(req.query),
    ),
  );

  // Unread-and-old — never opened and older than `months` (the attention angle).
  app.get<{ Querystring: PageQuery & { months?: string } }>('/api/cleanup/unread', async (req) =>
    paginateSlice(
      'unread',
      cachedSliceData('unread', { months: posNum(req.query.months) }),
      pageOpts(req.query),
    ),
  );

  // Newsletters / bulk mail — unsubscribe-marker heuristic (the bulk-mail angle).
  app.get<{ Querystring: PageQuery }>('/api/cleanup/newsletters', async (req) =>
    paginateSlice('newsletters', cachedSliceData('newsletters'), pageOpts(req.query)),
  );

  // Drill a delete-eligible slice down to individual messages (review surface), optionally
  // scoped to one sender domain. Re-runs the same safety + slice predicates as the preview.
  app.get<{
    Querystring: {
      slice?: string;
      years?: string;
      minMb?: string;
      months?: string;
      domain?: string;
      limit?: string;
      offset?: string;
    };
  }>('/api/cleanup/messages', async (req, reply): Promise<CleanupMessagesDto> => {
    const { slice, years, minMb, months, domain, limit, offset } = req.query;
    if (!slice || !isDeleteSlice(slice)) {
      return reply.code(400).send({ error: 'slice is not drillable' }) as never;
    }
    const lim = posNum(limit);
    const res = sliceMessages(slice, {
      years: posNum(years),
      minMb: posNum(minMb),
      months: posNum(months),
      domain: domain || undefined,
      limit: lim ? Math.min(lim, 500) : undefined,
      offset: posNum(offset),
    });
    return { slice, domain: domain || null, ...res };
  });

  // Execute a delete-eligible slice: re-resolve + re-validate server-side, tombstone locally
  // (instant hide), then enqueue the rate-limited MOVE-to-Trash. Returns the queued count.
  app.post<{ Body: CleanupExecuteRequest }>('/api/cleanup/execute', async (req, reply) => {
    const { slice, years, minMb, months, messageIds, domain, excludeDomains } = req.body ?? {};
    if (!slice || !isDeleteSlice(slice)) {
      return reply.code(400).send({ error: 'slice is not delete-eligible' });
    }

    // The scope (messageIds/domain/excludeDomains) only narrows the server-resolved eligible
    // set — the HARD safety gate is re-applied inside sliceMessageIds, never trusting the client.
    const refs = sliceMessageIds(slice, {
      years,
      minMb,
      months,
      messageIds,
      domain,
      excludeDomains,
    });
    for (const ref of refs) {
      markMessageDeleted(ref.id);
      emitSignal({ type: 'mail:deleted', accountId: ref.accountId, messageId: ref.id });
    }
    const queued = enqueueTrash(refs, slice);
    if (queued > 0) nudgeTrashQueue();

    const result: CleanupExecuteResultDto = { slice, queued };
    return result;
  });

  // Trash-queue progress (pending / failed / done) for the dashboard's "Moving N…" readout.
  app.get('/api/cleanup/queue', async () => queueStatus());
}
