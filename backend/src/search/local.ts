/**
 * Local full-text search: compile a canonical query IR into an FTS5 MATCH plus SQL
 * predicates and run it against the local cache. Never a LIKE-scan on the body
 * (ARCHITECTURE §12) — free-text terms drive the FTS index; field operators
 * (from/to/subject/date/attachment) compile to AND-ed predicates. The hybrid
 * cache-window-vs-server-fallback policy lives in `search.ts`; this module is purely
 * the local-index query compiler, lifted out of `db/queries.ts` so the read layer
 * stays generic and the search logic lives with the rest of `search/`.
 */
import { and, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { messages } from '../db/schema.js';
import type { MessageRow } from '../db/queries.js';
import { isEmptyQuery, parseQuery, type QueryIR } from './query.js';
import { rankCandidates, type RankCandidate } from './ranking.js';

/**
 * How many FTS candidates to retrieve per requested result before reranking.
 * Over-fetching gives the ranker (bm25 + recency/importance) room to reorder
 * beyond raw bm25; the cap bounds the JS rerank cost.
 */
const RERANK_OVERFETCH = 4;
const RERANK_CANDIDATE_CAP = 500;

/** Turn free-text terms into an FTS5 MATCH expression: prefix-match each, AND-joined. */
function toFtsMatch(terms: string[]): string {
  const words = terms.join(' ').match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.map((t) => `"${t}"*`).join(' ');
}

/** Escape LIKE wildcards so an operator value matches literally (ESCAPE '\\'). */
function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * SQL predicates compiled from a query IR's field operators (everything except the
 * free-text MATCH). Returned as raw SQL fragments to AND together; `m` is the
 * messages-table alias the caller must use.
 */
function irPredicates(ir: QueryIR): SQL[] {
  const preds: SQL[] = [];
  if (ir.from !== undefined) {
    const v = likeContains(ir.from);
    preds.push(sql`(m.from_address LIKE ${v} ESCAPE '\\' OR m.from_name LIKE ${v} ESCAPE '\\')`);
  }
  if (ir.to !== undefined) {
    const v = likeContains(ir.to);
    preds.push(sql`(m.to_addresses LIKE ${v} ESCAPE '\\' OR m.cc_addresses LIKE ${v} ESCAPE '\\')`);
  }
  if (ir.subject !== undefined) {
    preds.push(sql`m.subject LIKE ${likeContains(ir.subject)} ESCAPE '\\'`);
  }
  if (ir.sinceMs !== undefined) preds.push(sql`m.received_at >= ${ir.sinceMs}`);
  if (ir.beforeMs !== undefined) preds.push(sql`m.received_at < ${ir.beforeMs}`);
  if (ir.hasAttachment) {
    preds.push(
      sql`EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.is_inline = 0)`,
    );
  }
  if (ir.minAttachmentSize !== undefined) {
    preds.push(
      sql`EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.is_inline = 0 AND a.size_bytes >= ${ir.minAttachmentSize})`,
    );
  }
  if (ir.maxAttachmentSize !== undefined) {
    preds.push(
      sql`EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.is_inline = 0 AND a.size_bytes <= ${ir.maxAttachmentSize})`,
    );
  }
  if (ir.unread !== undefined) preds.push(sql`m.seen = ${ir.unread ? 0 : 1}`);
  if (ir.flagged) preds.push(sql`m.flagged = 1`);
  if (ir.answered) preds.push(sql`m.answered = 1`);
  if (ir.filename !== undefined) {
    // A filename LIKE on the small attachments table — same family as the from/to
    // operator LIKEs above, not a body scan (ARCHITECTURE §12 stays intact).
    const v = likeContains(ir.filename);
    preds.push(
      sql`EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.is_inline = 0 AND a.filename LIKE ${v} ESCAPE '\\')`,
    );
  }
  return preds;
}

/** Hydrate ordered message ids back to rows, preserving the id order. */
function hydrate(ids: string[]): MessageRow[] {
  if (ids.length === 0) return [];
  const byId = new Map(
    db
      .select()
      .from(messages)
      .where(and(inArray(messages.id, ids), isNull(messages.deletedAt)))
      .all()
      .map((m) => [m.id, m]),
  );
  return ids.map((id) => byId.get(id)).filter((m): m is MessageRow => Boolean(m));
}

/**
 * Compile a canonical query IR to FTS5 MATCH + SQL predicates and run it locally.
 * With free-text terms the FTS index supplies bm25 candidates which the pluggable
 * ranker (`ranking.ts`) reorders by bm25 + recency/importance; with only operators
 * there's no relevance signal so we order newest-first. Still never a LIKE on the
 * body (ARCHITECTURE §12). Tombstones are excluded.
 */
export function searchLocalIR(ir: QueryIR, limit: number): MessageRow[] {
  if (isEmptyQuery(ir)) return [];
  const match = toFtsMatch(ir.terms);
  const preds = irPredicates(ir);
  const predSql = preds.length ? sql` AND ${sql.join(preds, sql` AND `)}` : sql``;

  let ids: string[];
  if (match) {
    // Over-fetch raw bm25 candidates (plus the boost signals), then rerank in JS.
    const candidateLimit = Math.min(limit * RERANK_OVERFETCH, RERANK_CANDIDATE_CAP);
    const rows = db.all(
      sql`SELECT messages_fts.message_id AS id, bm25(messages_fts) AS bm25,
                 m.received_at AS received_at, m.flagged AS flagged
          FROM messages_fts
          JOIN messages m ON m.id = messages_fts.message_id
          WHERE messages_fts MATCH ${match} AND m.deleted_at IS NULL${predSql}
          ORDER BY rank LIMIT ${candidateLimit}`,
    ) as { id: string; bm25: number; received_at: number | null; flagged: number }[];
    const candidates: RankCandidate[] = rows.map((r) => ({
      id: r.id,
      bm25: r.bm25,
      receivedAtMs: r.received_at,
      flagged: r.flagged !== 0,
    }));
    ids = rankCandidates(candidates, limit);
  } else {
    const idRows = db.all(
      sql`SELECT m.id AS id FROM messages m
          WHERE m.deleted_at IS NULL${predSql}
          ORDER BY m.received_at DESC LIMIT ${limit}`,
    ) as { id: string }[];
    ids = idRows.map((r) => r.id);
  }
  return hydrate(ids);
}

/** Local search entry point: parse the user string into the IR, then compile + run. */
export function searchLocal(query: string, limit: number): MessageRow[] {
  return searchLocalIR(parseQuery(query), limit);
}
