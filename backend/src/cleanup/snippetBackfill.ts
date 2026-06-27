/**
 * Idempotent, self-healing backfill of `messages.snippet` for rows whose preview was
 * computed before {@link makeSnippet} learned to strip markup out of a contaminated
 * `text/plain` part. Some senders (e.g. Eloqua) leak an `<html …>`/preheader tag into
 * the plaintext alternative; the old snippet stored that tag verbatim, so the inbox
 * preview showed raw markup ("<html xml:lang=…") instead of the readable preheader.
 *
 * Targets only rows whose stored snippet still contains an HTML tag, recomputes the
 * snippet from the same bodies with the fixed logic, and writes it back when it
 * actually changes. A row converges to a tag-free snippet and stops matching, so
 * re-running is a no-op once the backlog is clean.
 *
 * Pure SQLite (no IMAP / filesystem). Wired into boot (index.ts) as a self-healing
 * startup pass, and runnable standalone as a CLI for a one-off.
 */
import { pathToFileURL } from 'node:url';
import { eq, isNotNull } from 'drizzle-orm';
import { db, sqlite } from '../db/client.js';
import { messages } from '../db/schema.js';
import { makeSnippet } from '../imap/parse.js';
import { createLogger } from '../logger.js';

const log = createLogger('snippet-backfill');

/** Same recognizable-tag probe as makeSnippet uses; cheap candidate filter here. */
const HTML_TAG_RE =
  /<\/?(?:!doctype|html|head|body|meta|title|style|div|span|table|tr|td|th|tbody|thead|p|br|hr|a|img|ul|ol|li|h[1-6]|font|center|b|strong|i|em)\b[^>]*>/i;

export interface SnippetBackfillResult {
  /** Rows whose stored snippet still contained an HTML tag when the pass started. */
  pending: number;
  /** Rows whose snippet was recomputed to a different (cleaned) value and rewritten. */
  fixed: number;
}

/** Recompute and rewrite contaminated snippets. Returns a small summary. */
export function backfillSnippets(): SnippetBackfillResult {
  // Cheap SQL pre-filter (`snippet LIKE '%<%'`) narrows the scan to rows that could
  // hold a tag; the regex then confirms an actual HTML tag before we recompute.
  const candidates = db
    .select({
      id: messages.id,
      snippet: messages.snippet,
      bodyText: messages.bodyText,
      bodyHtml: messages.bodyHtml,
    })
    .from(messages)
    .where(isNotNull(messages.snippet))
    .all()
    .filter((r) => r.snippet !== null && r.snippet.includes('<') && HTML_TAG_RE.test(r.snippet));

  if (candidates.length === 0) return { pending: 0, fixed: 0 };
  log.info(`snippet backfill — ${candidates.length} row(s) have a markup-contaminated snippet`);

  const updates: Array<{ id: string; snippet: string | null }> = [];
  for (const row of candidates) {
    const next = makeSnippet(row.bodyText, row.bodyHtml);
    if (next !== row.snippet) updates.push({ id: row.id, snippet: next });
  }

  // One transaction = one fsync for the whole pass (the source_bytes backfill learned
  // the hard way that per-row autocommit on WAL stalls boot on large backlogs).
  db.transaction((tx) => {
    for (const { id, snippet } of updates) {
      tx.update(messages).set({ snippet }).where(eq(messages.id, id)).run();
    }
  });

  log.info(`snippet backfill — fixed ${updates.length} snippet(s)`);
  return { pending: candidates.length, fixed: updates.length };
}

// Run standalone when invoked as a script (CLI), then close the connection.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    backfillSnippets();
    sqlite.close();
  } catch (err) {
    log.error('snippet backfill aborted:', err);
    process.exit(1);
  }
}
