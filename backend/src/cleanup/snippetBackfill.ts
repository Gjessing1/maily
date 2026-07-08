/**
 * Idempotent, self-healing backfill of `messages.snippet` for rows whose preview was
 * computed before {@link makeSnippet} learned to strip markup out of a contaminated
 * `text/plain` part. Some senders (e.g. Eloqua) leak an `<html …>`/preheader tag into
 * the plaintext alternative; the old snippet stored that tag verbatim, so the inbox
 * preview showed raw markup ("<html xml:lang=…") instead of the readable preheader.
 *
 * Targets only rows whose stored snippet still shows a known contamination (HTML
 * tag, link artifact, undecoded entity, invisible padding, doubled subject),
 * recomputes the snippet from the same bodies with the fixed logic, and writes it
 * back when it actually changes. A row converges to a clean snippet and stops
 * matching, so re-running is a no-op once the backlog is clean.
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

/** Mailparser link artifact (`label [https://…]` / `[mailto:…]`) leaked into a preview. */
const LINK_ARTIFACT_RE = /\[(?:https?:\/\/|mailto:)/i;

/**
 * Undecoded HTML entity (named or numeric) left verbatim in a preview — snippets
 * written before htmlToText learned full entity decoding show `&zwnj;`/`&Auml;`
 * spacer-and-accent soup instead of the preheader. A decoded `&` in prose ("R&D;")
 * can false-positive, which is harmless: the recompute writes only on change.
 */
const ENTITY_RE = /&(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#\d{1,7}|#x[0-9a-fA-F]{1,6});/;

/** Invisible preheader padding (same set makeSnippet strips). */
const INVISIBLE_RE = /[\u034F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/;

/** True if the stored snippet still opens with a verbatim copy of the subject. */
function startsWithSubject(snippet: string, subject: string | null): boolean {
  const subj = subject?.replace(/\s+/g, ' ').trim();
  return !!subj && subj.length >= 8 && snippet.startsWith(subj);
}

export interface SnippetBackfillResult {
  /** Rows whose stored snippet still contained an HTML tag when the pass started. */
  pending: number;
  /** Rows whose snippet was recomputed to a different (cleaned) value and rewritten. */
  fixed: number;
}

/** Recompute and rewrite contaminated snippets. Returns a small summary. */
export function backfillSnippets(): SnippetBackfillResult {
  // Recompute any preview still showing a known contamination: raw HTML markup, a
  // mailparser link artifact (`[https://…]` tracking blob), an undecoded HTML
  // entity or invisible preheader padding (`&zwnj;` spacer soup), or a verbatim
  // leading copy of the subject (newsletters repeat it as the first line, which
  // surfaced the subject twice instead of the preheader).
  const candidates = db
    .select({
      id: messages.id,
      subject: messages.subject,
      snippet: messages.snippet,
      bodyText: messages.bodyText,
      bodyHtml: messages.bodyHtml,
    })
    .from(messages)
    .where(isNotNull(messages.snippet))
    .all()
    .filter(
      (r) =>
        r.snippet !== null &&
        ((r.snippet.includes('<') && HTML_TAG_RE.test(r.snippet)) ||
          LINK_ARTIFACT_RE.test(r.snippet) ||
          ENTITY_RE.test(r.snippet) ||
          INVISIBLE_RE.test(r.snippet) ||
          startsWithSubject(r.snippet, r.subject)),
    );

  if (candidates.length === 0) return { pending: 0, fixed: 0 };
  log.info(`snippet backfill — ${candidates.length} row(s) have a contaminated snippet`);

  const updates: Array<{ id: string; snippet: string | null }> = [];
  for (const row of candidates) {
    const next = makeSnippet(row.bodyText, row.bodyHtml, row.subject);
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
