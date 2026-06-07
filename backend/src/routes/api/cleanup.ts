/**
 * Cleanup Dashboard API (ROADMAP Phase 6 "Master archive & Cleanup Dashboard").
 * Read-only deterministic analytics over the local SQLite archive (a storage audit plus the
 * delete-eligible slices — senders never replied to, cold-storage candidates — each with its
 * preview impact) PLUS the Phase 6b execution path: POST /execute queues a slice for trashing
 * and GET /queue reports trickle progress.
 *
 * Safety invariants on execute: the client sends only the slice + filters (never a message
 * list), and `sliceMessageIds` re-runs the SAME predicates the preview used — so the HARD
 * safety gate (financial/legal/account/medical) is re-applied at execution time. Trash-only:
 * messages are tombstoned locally then MOVEd to Trash by the rate-limited queue, never
 * EXPUNGEd, so the action is recoverable (archive-before-delete staging).
 */
import type { FastifyInstance } from 'fastify';
import type {
  CleanupExecuteRequest,
  CleanupExecuteResultDto,
  CleanupMessagesDto,
} from '@maily/shared';
import {
  cleanupSummary,
  coldStorageCandidates,
  neverRepliedSenders,
  sliceMessageIds,
  sliceMessages,
  storageByDomain,
} from '../../cleanup/slices.js';
import { enqueueTrash, nudgeTrashQueue, queueStatus } from '../../cleanup/trashQueue.js';
import { markMessageDeleted } from '../../imap/store.js';
import { emitSignal } from '../../events.js';

const DELETE_ELIGIBLE = new Set(['never-replied', 'cold-storage']);

export async function cleanupRoutes(app: FastifyInstance): Promise<void> {
  // Headline figures: total live mail, estimated bytes, protected-from-cleanup count.
  app.get('/api/cleanup/summary', async () => cleanupSummary());

  // Storage audit — every sender domain by estimated bytes (informational, not a preset).
  app.get('/api/cleanup/storage', async () => storageByDomain());

  // Senders never written back to — a passive bulk-unsubscribe / clutter candidate.
  app.get('/api/cleanup/never-replied', async () => neverRepliedSenders());

  // Cold-storage candidates — old mail without value markers (invoice/tax/contract).
  app.get<{ Querystring: { years?: string } }>('/api/cleanup/cold-storage', async (req) => {
    const years = Number(req.query.years);
    return coldStorageCandidates(Number.isFinite(years) && years > 0 ? years : undefined);
  });

  // Drill a delete-eligible slice down to individual messages (review surface), optionally
  // scoped to one sender domain. Re-runs the same safety + slice predicates as the preview.
  app.get<{
    Querystring: { slice?: string; years?: string; domain?: string; limit?: string; offset?: string };
  }>(
    '/api/cleanup/messages',
    async (req, reply): Promise<CleanupMessagesDto> => {
      const { slice, years, domain, limit, offset } = req.query;
      if (!slice || !DELETE_ELIGIBLE.has(slice)) {
        return reply.code(400).send({ error: 'slice is not drillable' }) as never;
      }
      const y = Number(years);
      const lim = Number(limit);
      const off = Number(offset);
      const res = sliceMessages(slice as 'never-replied' | 'cold-storage', {
        years: Number.isFinite(y) && y > 0 ? y : undefined,
        domain: domain || undefined,
        limit: Number.isFinite(lim) && lim > 0 ? Math.min(lim, 500) : undefined,
        offset: Number.isFinite(off) && off > 0 ? off : undefined,
      });
      return { slice, domain: domain || null, ...res };
    },
  );

  // Execute a delete-eligible slice: re-resolve + re-validate server-side, tombstone locally
  // (instant hide), then enqueue the rate-limited MOVE-to-Trash. Returns the queued count.
  app.post<{ Body: CleanupExecuteRequest }>('/api/cleanup/execute', async (req, reply) => {
    const { slice, years, excludeDomains } = req.body ?? {};
    if (!slice || !DELETE_ELIGIBLE.has(slice)) {
      return reply.code(400).send({ error: 'slice is not delete-eligible' });
    }

    const refs = sliceMessageIds(slice, { years, excludeDomains });
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
