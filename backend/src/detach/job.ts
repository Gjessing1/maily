/**
 * "Detach to local" job — delete mail from the provider while keeping the complete copy
 * on this server (ROADMAP storage / vendor-independence). For each in-scope message the
 * job moves the server copy to the provider Trash (recoverable there ~30 days, then
 * auto-purged) and flags the row `local_only`, LEAVING its local folder mappings intact
 * so it stays a normal member of the inbox — served entirely from the archived `.eml`.
 *
 * Safety: a message is only ever detached when its raw `.eml` is present on disk (the
 * "safe" set). A message with no local source would lose its attachments once the server
 * copy is gone (attachment bytes are lazy — ARCHITECTURE §4), so it is SKIPPED, never
 * deleted. Dry-run reports the split without touching anything.
 *
 * Idempotent + resumable: already-detached rows are excluded from the candidate set, and
 * `local_only` is set per successful batch, so a run interrupted by a dropped connection
 * resumes where it stopped on the next trigger.
 *
 * Single job at a time (server-wide), tracked in-memory; the UI polls {@link detachStatus}.
 */
import { existsSync } from 'node:fs';
import type { DetachPreviewDto, DetachRequest, DetachStatusDto } from '@maily/shared';
import { folderByRole, listDetachCandidates, uidLocationForMessage } from '../db/queries.js';
import { markMessageLocalOnly } from '../imap/store.js';
import { withTransientConnection } from '../imap/connection.js';
import { getEngine } from '../imap/registry.js';
import { createLogger } from '../logger.js';

const log = createLogger('detach');

/** UIDs moved per IMAP command — one MOVE per (folder, batch) keeps the server gentle. */
const MOVE_BATCH = 200;
/** Pause between move batches so a large run stays gentle on the provider. */
const INTER_BATCH_MS = 250;
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface JobState {
  state: 'idle' | 'running' | 'done' | 'error';
  accountId: string | null;
  total: number;
  processed: number;
  detached: number;
  skippedUnsafe: number;
  failed: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
}

const job: JobState = {
  state: 'idle',
  accountId: null,
  total: 0,
  processed: 0,
  detached: 0,
  skippedUnsafe: 0,
  failed: 0,
  startedAt: null,
  finishedAt: null,
  error: null,
};

export function detachStatus(): DetachStatusDto {
  return {
    state: job.state,
    accountId: job.accountId,
    total: job.total,
    processed: job.processed,
    detached: job.detached,
    skippedUnsafe: job.skippedUnsafe,
    failed: job.failed,
    startedAt: job.startedAt ? job.startedAt.toISOString() : null,
    finishedAt: job.finishedAt ? job.finishedAt.toISOString() : null,
    error: job.error,
  };
}

/** A message has a usable local copy iff its `.eml` is recorded AND present on disk. */
function hasLocalSource(sourcePath: string | null): sourcePath is string {
  return sourcePath !== null && existsSync(sourcePath);
}

function beforeMsFor(req: DetachRequest): number | undefined {
  return req.scope === 'cutoff' ? req.cutoffMs : undefined;
}

/** Dry-run: what a real run with this request would do. No mutation, no IMAP. */
export function previewDetach(req: DetachRequest): DetachPreviewDto {
  const candidates = listDetachCandidates(req.accountId, beforeMsFor(req));
  const safe = candidates.filter((c) => hasLocalSource(c.sourcePath));
  const unsafe = candidates.filter((c) => !hasLocalSource(c.sourcePath));

  let estimatedBytes = 0;
  let oldest: number | null = null;
  let newest: number | null = null;
  for (const c of safe) {
    estimatedBytes += c.sourceBytes ?? 0;
    const t = c.receivedAt ? c.receivedAt.getTime() : null;
    if (t !== null) {
      oldest = oldest === null ? t : Math.min(oldest, t);
      newest = newest === null ? t : Math.max(newest, t);
    }
  }

  return {
    accountId: req.accountId,
    scope: req.scope,
    cutoffMs: req.cutoffMs,
    total: candidates.length,
    safe: safe.length,
    unsafe: unsafe.length,
    estimatedBytes,
    oldest: oldest === null ? null : new Date(oldest).toISOString(),
    newest: newest === null ? null : new Date(newest).toISOString(),
    unsafeSamples: unsafe.slice(0, 10).map((c) => c.subject ?? '(no subject)'),
  };
}

/** Thrown by {@link startDetach} when the request can't run (returned as 409/400 by the route). */
export class DetachError extends Error {}

/**
 * Begin a detach run in the background and return the initial status. Throws
 * {@link DetachError} if a run is already in flight, the cutoff is missing, the account
 * isn't ready, or it has no Trash folder. The promise the route awaits resolves as soon
 * as the run is *started* — progress is observed via {@link detachStatus}.
 */
export function startDetach(req: DetachRequest): DetachStatusDto {
  if (job.state === 'running') throw new DetachError('a detach run is already in progress');
  if (req.scope === 'cutoff' && !req.cutoffMs)
    throw new DetachError('cutoff scope needs a cutoffMs');

  const engine = getEngine(req.accountId);
  if (!engine) throw new DetachError(`account ${req.accountId} is not ready`);
  const trash = folderByRole(req.accountId, 'trash');
  if (!trash) throw new DetachError('account has no Trash folder to move messages into');

  const candidates = listDetachCandidates(req.accountId, beforeMsFor(req));
  const safe = candidates.filter((c) => hasLocalSource(c.sourcePath));
  const unsafe = candidates.length - safe.length;

  job.state = 'running';
  job.accountId = req.accountId;
  job.total = safe.length;
  job.processed = 0;
  job.detached = 0;
  job.skippedUnsafe = unsafe;
  job.failed = 0;
  job.startedAt = new Date();
  job.finishedAt = null;
  job.error = null;

  // Fire-and-forget: the route returns immediately; the UI polls status.
  void runDetach(
    engine.accountConfig,
    safe.map((c) => c.id),
    { id: trash.id, path: trash.path },
  );

  return detachStatus();
}

/**
 * Move each safe message's server copy to Trash (no local relink — mappings stay so it
 * keeps showing in the inbox) and flag it `local_only`. Groups by source folder and
 * batches the UID MOVE; one transient connection for the whole run. A drop mid-run is
 * recoverable: detached rows are already flagged, so re-triggering resumes.
 */
async function runDetach(
  config: Parameters<typeof withTransientConnection>[0],
  messageIds: string[],
  trash: { id: string; path: string },
): Promise<void> {
  try {
    // Group by the source folder we'll move FROM (skip any already in Trash → just flag).
    const byFolder = new Map<string, { id: string; uid: number }[]>();
    for (const id of messageIds) {
      const loc = uidLocationForMessage(id);
      if (!loc || loc.folderPath === trash.path) {
        // No live server location (or already trashed) — nothing to move; flag locally.
        markMessageLocalOnly(id);
        job.processed += 1;
        job.detached += 1;
        continue;
      }
      const list = byFolder.get(loc.folderPath) ?? [];
      list.push({ id, uid: loc.uid });
      byFolder.set(loc.folderPath, list);
    }

    if (byFolder.size === 0) {
      finish();
      return;
    }

    await withTransientConnection(config, async (client) => {
      for (const [folderPath, items] of byFolder) {
        const lock = await client.getMailboxLock(folderPath);
        try {
          for (let i = 0; i < items.length; i += MOVE_BATCH) {
            const batch = items.slice(i, i + MOVE_BATCH);
            const uidSet = batch.map((b) => b.uid).join(',');
            try {
              await client.messageMove(uidSet, trash.path, { uid: true });
              for (const b of batch) markMessageLocalOnly(b.id);
              job.detached += batch.length;
            } catch (err) {
              job.failed += batch.length;
              log.warn(`move batch failed (${folderPath}): ${(err as Error).message}`);
            }
            job.processed += batch.length;
            if (i + MOVE_BATCH < items.length) await delay(INTER_BATCH_MS);
          }
        } finally {
          lock.release();
        }
      }
    });

    finish();
  } catch (err) {
    job.state = 'error';
    job.error = (err as Error).message;
    job.finishedAt = new Date();
    log.error(`detach run failed: ${(err as Error).message}`);
  }
}

function finish(): void {
  job.state = 'done';
  job.finishedAt = new Date();
  log.info(
    `detach done: detached ${job.detached}, skipped ${job.skippedUnsafe} unsafe, ${job.failed} failed`,
  );
}
