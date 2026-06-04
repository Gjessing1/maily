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
 * With free-text terms the FTS index drives ranking; with only operators we scan
 * messages by the predicates (still never a LIKE on the body — ARCHITECTURE §12)
 * ordered newest-first. Tombstones are excluded.
 */
export function searchLocalIR(ir: QueryIR, limit: number): MessageRow[] {
  if (isEmptyQuery(ir)) return [];
  const match = toFtsMatch(ir.terms);
  const preds = irPredicates(ir);
  const predSql = preds.length ? sql` AND ${sql.join(preds, sql` AND `)}` : sql``;

  let idRows: { id: string }[];
  if (match) {
    idRows = db.all(
      sql`SELECT messages_fts.message_id AS id FROM messages_fts
          JOIN messages m ON m.id = messages_fts.message_id
          WHERE messages_fts MATCH ${match} AND m.deleted_at IS NULL${predSql}
          ORDER BY rank LIMIT ${limit}`,
    ) as { id: string }[];
  } else {
    idRows = db.all(
      sql`SELECT m.id AS id FROM messages m
          WHERE m.deleted_at IS NULL${predSql}
          ORDER BY m.received_at DESC LIMIT ${limit}`,
    ) as { id: string }[];
  }
  return hydrate(idRows.map((r) => r.id));
}

/** Local search entry point: parse the user string into the IR, then compile + run. */
export function searchLocal(query: string, limit: number): MessageRow[] {
  return searchLocalIR(parseQuery(query), limit);
}
