/**
 * Offline rebuild of the derived message cache from the canonical `.eml` archive
 * (ROADMAP §3.7.E / ARCHITECTURE §15 — "index-rebuild independence").
 *
 * The raw `.eml` on disk is the canonical content store; the parsed columns, snippet
 * and FTS index are a *rebuildable cache* over it. This command reparses every
 * archived message (`source_path` set) and rewrites those content columns — with ZERO
 * IMAP refetch — so a dropped/corrupted FTS index or a parser change can be reconciled
 * offline. Mailbox state that is NOT in RFC822 (flags, `message_folders`, tombstones,
 * `received_at`, the identity/thread keys) is preserved untouched (`updateMessageContent`);
 * FTS follows automatically via the messages-table UPDATE trigger (migration 0003).
 *
 * Un-swept history (null `source_path`) is skipped — its parsed row is its only copy.
 * Idempotent: keyed by message UUID, a re-run reproduces the same rows. This is the
 * forerunner of the Phase 4 *reindex mode*; when enrichers exist they hook in here.
 *
 * Run standalone: `npm run db:rebuild` (in the backend workspace).
 */
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { messagesWithSource } from './queries.js';
import { updateMessageContent } from '../imap/store.js';
import { parseSourceContent } from '../imap/source-parse.js';
import { sqlite } from './client.js';
import { createLogger } from '../logger.js';

const log = createLogger('rebuild');

export interface RebuildResult {
  total: number;
  rebuilt: number;
  /** `source_path` set but the file is gone — the archive lost a message; logged, skipped. */
  missing: number;
  /** Parse failures — the `.eml` is present but unreadable; logged, skipped. */
  failed: number;
}

/**
 * Reparse every archived message and rewrite its content columns. Per-message failures
 * (a missing or unparsable `.eml`) are counted and skipped, never fatal, so one bad file
 * can't abort a full rebuild. Returns the tallies for the CLI summary.
 */
export async function rebuildFromSource(): Promise<RebuildResult> {
  const rows = messagesWithSource();
  const result: RebuildResult = { total: rows.length, rebuilt: 0, missing: 0, failed: 0 };
  log.info(`rebuilding ${rows.length} archived message(s) from source`);

  for (const { id, sourcePath } of rows) {
    if (!existsSync(sourcePath)) {
      result.missing += 1;
      log.warn(`source missing for ${id}: ${sourcePath}`);
      continue;
    }
    try {
      updateMessageContent(id, await parseSourceContent(sourcePath));
      result.rebuilt += 1;
      if (result.rebuilt % 500 === 0) log.info(`  …${result.rebuilt}/${rows.length}`);
    } catch (err) {
      result.failed += 1;
      log.warn(`rebuild failed for ${id}: ${(err as Error).message}`);
    }
  }

  log.info(
    `rebuild done: ${result.rebuilt} rebuilt, ${result.missing} missing, ${result.failed} failed`,
  );
  return result;
}

// Run standalone when invoked as a script (CLI), then close the connection.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  rebuildFromSource()
    .then(() => sqlite.close())
    .catch((err) => {
      log.error('rebuild aborted:', err);
      process.exit(1);
    });
}
