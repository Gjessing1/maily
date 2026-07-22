/**
 * Idempotent, self-healing backfill of `messages.snippet` for rows whose preview was
 * computed by an older, buggier {@link makeSnippet} — a leaked `<html …>` tag from a
 * contaminated `text/plain` part (Eloqua), `&zwnj;` spacer soup, a Word/Outlook
 * conditional-comment settings block ("Clean Clean DocumentEmail … X-NONE"), or an
 * opaque tracking URL filling the whole line.
 *
 * Recomputes the snippet for every message from its stored bodies and writes it back
 * only when it actually differs, so the pass converges and re-running is a no-op.
 * Deliberately *not* filtered by "does the stored snippet look contaminated" markers:
 * each fix to makeSnippet invented a new kind of residue, and the marker list always
 * lagged behind it. Recomputing outright costs ~4s on ~25k messages (a streamed scan of
 * the bodies plus makeSnippet on each), runs off the listen path, and can never miss a
 * row — the marker-filtered version silently left 1811 stale snippets behind.
 *
 * Pure SQLite (no IMAP / filesystem). Wired into boot (index.ts) as a self-healing
 * startup pass, and runnable standalone as a CLI for a one-off.
 */
import { pathToFileURL } from 'node:url';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '../db/client.js';
import { messages } from '../db/schema.js';
import { makeSnippet } from '../imap/parse.js';
import { createLogger } from '../logger.js';

const log = createLogger('snippet-backfill');

interface Row {
  id: string;
  subject: string | null;
  snippet: string | null;
  body_text: string | null;
  body_html: string | null;
}

export interface SnippetBackfillResult {
  /** Rows examined (every message that has a snippet). */
  scanned: number;
  /** Rows whose snippet was recomputed to a different (cleaned) value and rewritten. */
  fixed: number;
  /** Stale rows left for the next pass because the write budget ran out. */
  deferred: number;
}

/**
 * Default write budget. Writes are the expensive half: a snippet UPDATE on a message
 * with no body_text still re-indexes FTS, and that delete is a linear scan of the
 * index (see migration 0025). A one-off backlog of ~10k rows would otherwise block
 * boot for minutes, so cap the work and let successive boots converge.
 */
const DEFAULT_BUDGET_MS = 20_000;

/** Recompute and rewrite stale snippets. Returns a small summary. */
export function backfillSnippets(budgetMs = DEFAULT_BUDGET_MS): SnippetBackfillResult {
  // Stream rather than `.all()`: bodies are the two widest columns in the schema, and
  // materializing every message's HTML at once is a multi-hundred-MB spike on boot.
  // Only the (small) pending updates are held, then applied after the cursor closes —
  // better-sqlite3 will not write on a connection with an open iterator.
  const cursor = sqlite
    .prepare<
      [],
      Row
    >('SELECT id, subject, snippet, body_text, body_html FROM messages WHERE snippet IS NOT NULL')
    .iterate();

  let scanned = 0;
  const updates: Array<{ id: string; snippet: string | null }> = [];
  for (const row of cursor) {
    scanned++;
    const next = makeSnippet(row.body_text, row.body_html, row.subject);
    if (next !== row.snippet) updates.push({ id: row.id, snippet: next });
  }

  if (updates.length === 0) return { scanned, fixed: 0, deferred: 0 };
  log.info(`snippet backfill — ${updates.length} of ${scanned} snippet(s) are stale`);

  // One transaction = one fsync for the whole pass (the source_bytes backfill learned
  // the hard way that per-row autocommit on WAL stalls boot on large backlogs). The
  // budget is checked inside, so a partial pass still commits what it managed.
  let fixed = 0;
  const deadline = Date.now() + budgetMs;
  db.transaction((tx) => {
    for (const { id, snippet } of updates) {
      if (fixed > 0 && fixed % 64 === 0 && Date.now() > deadline) break;
      tx.update(messages).set({ snippet }).where(eq(messages.id, id)).run();
      fixed++;
    }
  });

  const deferred = updates.length - fixed;
  log.info(
    deferred > 0
      ? `snippet backfill — fixed ${fixed} snippet(s), ${deferred} deferred to the next pass`
      : `snippet backfill — fixed ${fixed} snippet(s)`,
  );
  return { scanned, fixed, deferred };
}

/** Pause between drain passes — long enough to let IMAP sync take the write lock. */
const DRAIN_GAP_MS = 30_000;
/** Stop re-arming after this many passes; a backlog that won't shrink is a bug, not work. */
const MAX_DRAIN_PASSES = 50;

/**
 * Run budgeted passes until the backlog is drained, pausing in between. SQLite has a
 * single writer, so one long transaction would stall IMAP sync for its whole duration;
 * chunking with a gap keeps each lock-hold short. Fire-and-forget — the timer is
 * unref'd so it never keeps the process alive.
 */
export function drainSnippets(pass = 1): void {
  let result: SnippetBackfillResult;
  try {
    result = backfillSnippets();
  } catch (err) {
    log.error('snippet backfill failed (non-fatal):', err);
    return;
  }
  if (result.deferred === 0) return;
  if (pass >= MAX_DRAIN_PASSES) {
    // Converging snippets stop being stale; a backlog that survives this many passes
    // means makeSnippet's output doesn't round-trip through SQLite (a lone surrogate
    // from mid-emoji truncation did exactly that), so stop instead of rewriting forever.
    log.warn(
      `snippet backfill — ${result.deferred} row(s) still stale after ${pass} passes; stopping`,
    );
    return;
  }
  setTimeout(() => drainSnippets(pass + 1), DRAIN_GAP_MS).unref();
}

// Run standalone when invoked as a script (CLI), then close the connection. No budget
// here: the CLI is the deliberate one-off drain, not the boot path.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    backfillSnippets(Number.POSITIVE_INFINITY);
    sqlite.close();
  } catch (err) {
    log.error('snippet backfill aborted:', err);
    process.exit(1);
  }
}
