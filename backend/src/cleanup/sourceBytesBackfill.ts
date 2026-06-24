/**
 * Idempotent, self-healing backfill of `messages.source_bytes` (ROADMAP Phase 6 cleanup
 * storage metric / detach size estimate). Rows archived before the `source_bytes` column
 * existed have a `source_path` but a NULL `source_bytes`, so the byte estimates
 * (slices.ts `BYTES`, the detach preview) under-count their dominant on-disk cost — the
 * `.eml` (with attachments) is the largest per-message cost. This stats each such `.eml`
 * once and records its real size.
 *
 * Targets `source_path IS NOT NULL AND (source_bytes IS NULL OR source_bytes = 0)`, so it
 * fills the historical NULL backlog AND self-heals any row a buggy write left at 0. A row
 * whose file is present converges to a positive size and stops matching, so re-running is
 * a no-op once the archive is fully measured. A missing file (archive lost a message) is
 * recorded as 0 — mirroring how rebuild.ts treats a vanished source as a skip, not a crash.
 *
 * Pure SQLite + filesystem (no IMAP). Wired into boot ({@link backfillSourceBytes} in
 * index.ts) as a self-healing startup pass, and runnable standalone as a CLI for a one-off.
 */
import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { and, eq, isNotNull, isNull, or } from 'drizzle-orm';
import { db, sqlite } from '../db/client.js';
import { messages } from '../db/schema.js';
import { createLogger } from '../logger.js';

const log = createLogger('source-bytes-backfill');

export interface BackfillResult {
  /** Rows that had a source_path but no (or a zeroed) source_bytes when the pass started. */
  pending: number;
  /** Rows whose `.eml` was stat-ed and source_bytes recorded (file present). */
  filled: number;
  /** Rows whose `.eml` was gone — recorded as 0 bytes so they are not retried. */
  missing: number;
}

/**
 * Fill `source_bytes` for every archived row that lacks it. Returns a small summary.
 * Each row is updated in its own statement (the set is small and runs once); on a
 * missing file we still write 0 so the WHERE predicate stops matching the row.
 */
export function backfillSourceBytes(): BackfillResult {
  const rows = db
    .select({ id: messages.id, sourcePath: messages.sourcePath })
    .from(messages)
    .where(
      and(
        isNotNull(messages.sourcePath),
        or(isNull(messages.sourceBytes), eq(messages.sourceBytes, 0)),
      ),
    )
    .all()
    .filter((r): r is { id: string; sourcePath: string } => r.sourcePath !== null);

  if (rows.length === 0) return { pending: 0, filled: 0, missing: 0 };
  log.info(`source_bytes backfill — ${rows.length} archived row(s) need a size`);

  let filled = 0;
  let missing = 0;
  for (const { id, sourcePath } of rows) {
    let size: number;
    try {
      size = statSync(sourcePath).size;
      filled += 1;
    } catch {
      // Archive lost this message; record 0 so the row stops matching and isn't retried.
      size = 0;
      missing += 1;
      log.warn(`source missing for ${id}: ${sourcePath} — recording 0 bytes`);
    }
    db.update(messages).set({ sourceBytes: size }).where(eq(messages.id, id)).run();
  }

  log.info(`source_bytes backfill — filled ${filled}, ${missing} missing (recorded 0)`);
  return { pending: rows.length, filled, missing };
}

// Run standalone when invoked as a script (CLI), then close the connection.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    backfillSourceBytes();
    sqlite.close();
  } catch (err) {
    log.error('source_bytes backfill aborted:', err);
    process.exit(1);
  }
}
