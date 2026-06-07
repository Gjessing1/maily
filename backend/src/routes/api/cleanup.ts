/**
 * Cleanup Dashboard API (ROADMAP Phase 6 "Master archive & Cleanup Dashboard").
 * Read-only deterministic analytics over the local SQLite archive: a storage audit plus
 * delete-eligible slices (senders never replied to, cold-storage candidates), each with
 * its preview impact (count + estimated storage, grouped by sender domain).
 *
 * These are GET-only on purpose. The destructive execution path (rate-limited IMAP trash
 * queue, archive-before-delete staging, 1-click presets) is a separate, later pass — the
 * roadmap requires previewing impact before any execution, and bulk delete is hard to
 * reverse, so the analytics land and get verified first. The delete-eligible slices are
 * already safety-filtered (financial/legal/account/medical mail excluded — HARD RULE).
 */
import type { FastifyInstance } from 'fastify';
import {
  cleanupSummary,
  coldStorageCandidates,
  neverRepliedSenders,
  storageByDomain,
} from '../../cleanup/slices.js';

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
}
